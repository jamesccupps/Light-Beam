package app.beam.android.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Seals and opens this device's sign-in for storage (Beam 1.7.6, audit S-23). Null means "can't here": [Prefs] then
 * keeps it as before, so a phone whose Keystore misbehaves never loses its sign-in.
 */
interface SecretBox {
    fun seal(plain: String): String?
    fun open(sealed: String): String?
}

/**
 * AES-GCM with a key that lives in Android's Keystore (hardware-backed where the phone has it): what's in the
 * preferences file is no use anywhere else, the way the Windows app's sign-in is sealed with DPAPI.
 */
class KeystoreBox : SecretBox {
    private fun key(create: Boolean): SecretKey? {
        val store = KeyStore.getInstance(STORE).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    override fun seal(plain: String): String? = try {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key(create = true))
        PREFIX + Base64.encodeToString(cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    } catch (_: Exception) {
        null
    }

    override fun open(sealed: String): String? {
        if (!sealed.startsWith(PREFIX)) return null
        return try {
            val key = key(create = false) ?: return null
            val all = Base64.decode(sealed.substring(PREFIX.length), Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, all, 0, IV))
            String(cipher.doFinal(all, IV, all.size - IV), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    private companion object {
        const val STORE = "AndroidKeyStore"
        const val ALIAS = "beam-sign-in"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val PREFIX = "k1:"
        const val IV = 12
    }
}
