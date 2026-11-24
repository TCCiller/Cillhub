package io.github.mrciller.cillhub.data

import io.github.mrciller.cillhub.Api
import io.github.mrciller.cillhub.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/**
 * An API error: HTTP status (0 = unreachable), v9 error code, the server's message, retry_after for 429s, and captcha:
 * the server wants a captcha token (sign-up and password reset, 7.10).
 */
class ApiError(val status: Int, val code: Int, message: String, val retryAfter: Double = 0.0, val captcha: Boolean = false, val acceptTerms: Boolean = false) : IOException(message) {
    companion object {
        /** The server's terms gate message (403 required_actions: accept_terms); "" once the user closed it. */
        val termsGate = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)

        /** The first field message of a 50035 answer ("Username is unavailable."), else the message. Any body shape is read
         *  without throwing (only ApiError leaves here): a field of an unexpected type counts as absent. */
        fun parse(status: Int, text: String, retryHeader: String?): ApiError {
            val body = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()
            val code = body?.get("code").prim()?.intOrNull ?: 0
            val msg = (if (code == 50035) firstFieldError(body?.get("errors")) else null) ?: body?.get("message").prim()?.contentOrNull ?: "Request failed ($status)"
            val retry = body?.get("retry_after").prim()?.doubleOrNull ?: retryHeader?.toDoubleOrNull() ?: 0.0
            val terms = (body?.get("required_actions") as? JsonArray)?.any { it.prim()?.contentOrNull == "accept_terms" } == true
            return ApiError(status, code, msg, retry, captcha = body?.containsKey("captcha_key") == true, acceptTerms = terms)
        }

        private fun JsonElement?.prim() = this as? JsonPrimitive

        private fun firstFieldError(e: JsonElement?, depth: Int = 0): String? {
            val o = e as? JsonObject ?: return null
            if (depth > 16) return null
            ((o["_errors"] as? JsonArray)?.firstOrNull() as? JsonObject)?.get("message").prim()?.contentOrNull?.let { return it }
            return o.values.firstNotNullOfOrNull { firstFieldError(it, depth + 1) }
        }
    }
}

/** A file to upload: opened lazily so large files stream instead of sitting in memory. */
class Upload(val name: String, val size: Long, val mime: String, val open: () -> java.io.InputStream)

/**
 * Suspending REST client for the UI (OkHttp + kotlinx.serialization). Rate limits: a 429 with a short retry_after
 * is waited out and retried (twice at most); message sends never retry silently, so slowmode reaches the user.
 */
class Rest(private val base: () -> String, private val token: () -> String?) {
    companion object {
        /** Decodes a 2xx reply body; any syntax or shape failure becomes an [ApiError] without echoing the body. */
        inline fun <reified T> decode(text: String): T = try {
            json.decodeFromString(text)
        } catch (e: IllegalArgumentException) {
            // 502 (Bad Gateway): non-zero so Common.errorText surfaces this message instead of "can't reach server"
            // and E2ee.decrypt does not retry a persistent shape mismatch as offline.
            throw ApiError(502, 0, "Unexpected server response")
        }
    }

    private val JSON = "application/json".toMediaType()

    suspend fun request(method: String, path: String, body: JsonElement? = null, retry: Boolean = true): String =
        send(retry) { b ->
            val rb = body?.toString()?.toRequestBody(JSON) ?: if (method in setOf("POST", "PUT", "PATCH")) ByteArray(0).toRequestBody(null) else null
            b.url(base() + path).method(method, rb)
        }

    suspend inline fun <reified T> get(path: String): T = decode(request("GET", path))
    suspend inline fun <reified T> call(method: String, path: String, body: JsonElement? = null, retry: Boolean = true): T = decode(request(method, path, body, retry))

    /** POST multipart with payload_json and files[n] (CONTRACT-v2 section 6), reporting upload progress 0..1. */
    suspend inline fun <reified T> multipart(path: String, payload: JsonObject, files: List<Upload>, noinline progress: (Float) -> Unit = {}): T =
        decode(sendMultipart(path, payload, files, progress))

    @PublishedApi internal suspend fun sendMultipart(path: String, payload: JsonObject, files: List<Upload>, progress: (Float) -> Unit = {}): String {
        val total = files.sumOf { it.size }.coerceAtLeast(1)
        var sent = 0L
        val form = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("payload_json", payload.toString())
        files.forEachIndexed { i, f ->
            form.addFormDataPart("files[$i]", f.name, object : RequestBody() {
                override fun contentType() = f.mime.toMediaType()
                override fun contentLength() = if (f.size > 0) f.size else -1
                override fun writeTo(sink: okio.BufferedSink) {
                    f.open().use { input ->
                        val buf = ByteArray(32 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            sink.write(buf, 0, n)
                            sent += n
                            progress((sent.toFloat() / total).coerceAtMost(1f))
                        }
                    }
                }
            })
        }
        return send(retry = false) { it.url(base() + path).post(form.build()) }
    }

    private suspend fun send(retry: Boolean, build: (Request.Builder) -> Request.Builder): String {
        var attempt = 0
        while (true) {
            val b = Request.Builder().header("User-Agent", "Cillhub-Android/${BuildConfig.VERSION_NAME}")
            token()?.let { b.header("Authorization", it) }
            val req = build(b).build()
            val (code, text, retryAfter) = withContext(Dispatchers.IO) {
                try {
                    Api.http.newCall(req).execute().use { Triple(it.code, it.body.string(), it.header("Retry-After")) }
                } catch (e: IOException) {
                    throw ApiError(0, 0, e.message ?: "unreachable")
                }
            }
            if (code in 200..299) return text
            val err = ApiError.parse(code, text, retryAfter)
            if (err.acceptTerms && ApiError.termsGate.value == null) ApiError.termsGate.value = err.message
            if (code == 429 && retry && attempt < 2 && err.retryAfter in 0.0..5.0) {
                attempt++
                delay((err.retryAfter * 1000).toLong() + 100)
                continue
            }
            throw err
        }
    }
}
