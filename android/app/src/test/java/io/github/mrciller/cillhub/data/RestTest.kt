package io.github.mrciller.cillhub.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/** Successful (2xx) replies with HTML, empty, or wrong-shape bodies must throw ApiError without echoing the body. */
class RestTest {
    private fun withServer(body: String, contentType: String = "application/json", block: suspend (Rest) -> Unit) {
        ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { server ->
            val bytes = body.toByteArray(Charsets.UTF_8)
            val t = thread(isDaemon = true) {
                server.accept().use { sock ->
                    val input = sock.getInputStream().bufferedReader()
                    while (true) {
                        val line = input.readLine() ?: break
                        if (line.isEmpty()) break
                    }
                    val header = "HTTP/1.1 200 OK\r\nContent-Type: $contentType\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
                    sock.getOutputStream().apply {
                        write(header.toByteArray(Charsets.US_ASCII))
                        write(bytes)
                        flush()
                    }
                }
            }
            try {
                runBlocking { block(Rest({ "http://127.0.0.1:${server.localPort}" }, { null })) }
            } finally {
                t.join(2000)
            }
        }
    }

    private fun assertDecodeApiError(body: String, marker: String?, contentType: String = "application/json", call: suspend (Rest) -> Unit) {
        withServer(body, contentType) { rest ->
            try {
                call(rest)
                fail("expected ApiError for body: $body")
            } catch (e: ApiError) {
                assertNotEquals("decode failure must not masquerade as unreachable/offline (status 0)", 0, e.status)
                val msg = e.message ?: ""
                assertTrue("expected non-empty fixed message", msg.isNotBlank())
                if (marker != null) assertFalse("error message must not echo reply body", msg.contains(marker))
            }
        }
    }

    @Test fun htmlReplyThrowsApiErrorWithoutEchoingBody() {
        val html = "<html><body><h1>Captive Portal SECRET_PORTAL_BODY</h1></body></html>"
        assertDecodeApiError(html, "SECRET_PORTAL_BODY", "text/html") { it.get<LoginAnswer>("/auth/login") }
        assertDecodeApiError(html, "Captive Portal", "text/html") { it.call<JsonObject>("POST", "/guilds") }
    }

    @Test fun emptyReplyThrowsApiError() {
        assertDecodeApiError("", null) { it.get<LoginAnswer>("/users/@me") }
        assertDecodeApiError("", null) { it.call<JsonObject>("POST", "/guilds") }
    }

    @Test fun wrongJsonShapeThrowsApiErrorWithoutEchoingBody() {
        val wrongObject = """{"unexpected_key":"SECRET_SHAPE_VALUE"}"""
        assertDecodeApiError(wrongObject, "SECRET_SHAPE_VALUE") { it.get<Message>("/channels/1/messages") }
        val jsonArray = """["SECRET_ARRAY_VALUE"]"""
        assertDecodeApiError(jsonArray, "SECRET_ARRAY_VALUE") { it.call<JsonObject>("POST", "/guilds") }
        assertDecodeApiError("null", "null") { it.call<JsonObject>("PATCH", "/channels/1/messages/2") }
    }

    @Test fun validRepliesStillDecode() {
        withServer("""{"token":"tok_123","user_id":"42"}""") { rest ->
            val ans = rest.get<LoginAnswer>("/auth/login")
            assertEquals("tok_123", ans.token)
            assertEquals("42", ans.userId)
        }
        withServer("""{"id":"99","name":"guild"}""") { rest ->
            val obj = rest.call<JsonObject>("POST", "/guilds")
            assertEquals("99", obj["id"]?.jsonPrimitive?.content)
        }
    }
}
