package io.github.mrciller.cillhub.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Decrypted files of encrypted DMs stay in their cache folder whatever attachment id the server sends. */
class E2eeFilesTest {
    private val root = Files.createTempDirectory("e2ee-files").toFile().apply { deleteOnExit() }
    private val dir = File(root, "cache/e2ee").apply { mkdirs() }

    @Test fun snowflakeIdsGiveAFileInTheCacheFolder() {
        val f = decryptedFile(dir, "1234567890123456789", "holiday photo.jpg")!!
        assertEquals(dir.canonicalFile, f.canonicalFile.parentFile)
        assertEquals("1234567890123456789-holiday photo.jpg", f.name)
        assertEquals("7-.._.._x_y.png", decryptedFile(dir, "7", "../../x/y.png")!!.name) // the name never walks out
    }

    @Test fun anIdOtherThanASnowflakeIsRefused() {
        // an existing private file the server would otherwise have the app open (and offer to share) as the attachment
        File(root, "shared_prefs").mkdirs()
        File(root, "shared_prefs/keys-x.xml").writeText("secret")
        for (id in listOf("../../shared_prefs/keys", "../x", "/etc/passwd", "1/2", "", "12a", "1".repeat(21), "1\u0000")) {
            assertNull(id, decryptedFile(dir, id, "x.xml"))
        }
    }
}
