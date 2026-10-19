package com.shareeven.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.ViewManager
import java.io.File
import java.lang.ref.WeakReference
import java.util.UUID

/**
 * "Share to ShareEven" from the gallery or any other app (the intent filters in AndroidManifest.xml).
 *
 * Other apps hand over content:// addresses that are only readable for a short while, so the shared
 * files are copied into this app's cache first. The app then asks which chats to send them to
 * (src/share/IncomingShare.tsx) and sends them like any attachment, end-to-end encrypted.
 */
class ShareModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "ShareEvenShare"

  init {
    current = WeakReference(this)
  }

  /** What was shared to the app ({ text?, files: [{ uri, type, name, size }] }), once; null if nothing. */
  @ReactMethod
  fun take(promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    val intent = activity?.intent
    if (intent == null || !isShare(intent)) {
      promise.resolve(null)
      return
    }
    activity.intent = Intent(Intent.ACTION_MAIN) // handled: a rotation or a reopen doesn't share it again
    Thread {
      try {
        promise.resolve(read(reactApplicationContext, intent))
      } catch (e: Exception) {
        promise.reject("share_failed", e.message, e)
      }
    }.start()
  }

  // For NativeEventEmitter
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  companion object {
    const val EVENT_SHARED = "ShareEvenShared"
    private const val MAX_FILES = 10
    private var current: WeakReference<ShareModule>? = null

    private fun isShare(intent: Intent) = intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE

    /** Something was shared while the app was already open: the app takes it (see MainActivity). */
    fun onNewIntent(intent: Intent) {
      if (isShare(intent)) current?.get()?.reactApplicationContext?.emitDeviceEvent(EVENT_SHARED, null)
    }

    @Suppress("DEPRECATION")
    private fun streams(intent: Intent): List<Uri> = when {
      intent.action == Intent.ACTION_SEND_MULTIPLE && Build.VERSION.SDK_INT >= 33 ->
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
      intent.action == Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
      Build.VERSION.SDK_INT >= 33 -> listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))
      else -> listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM))
    }

    private fun read(context: Context, intent: Intent): WritableMap {
      val out = Arguments.createMap()
      intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() }?.let { out.putString("text", it.take(4000)) }
      val files = Arguments.createArray()
      val folder = File(context.cacheDir, "shared").apply { mkdirs() }
      for (uri in streams(intent).take(MAX_FILES)) {
        val resolver = context.contentResolver
        val type = resolver.getType(uri) ?: intent.type?.takeIf { !it.contains('*') } ?: "application/octet-stream"
        var name: String? = null
        var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
          if (c.moveToFirst()) {
            name = c.getString(0)
            if (!c.isNull(1)) size = c.getLong(1)
          }
        }
        val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(type) ?: "bin"
        val target = File(folder, "${UUID.randomUUID()}.$extension")
        val input = resolver.openInputStream(uri) ?: continue
        input.use { source -> target.outputStream().use { source.copyTo(it) } }
        files.pushMap(Arguments.createMap().apply {
          putString("uri", Uri.fromFile(target).toString())
          putString("type", type)
          putString("name", (name ?: target.name).take(200))
          putDouble("size", (if (size >= 0) size else target.length()).toDouble())
        })
      }
      out.putArray("files", files)
      return out
    }
  }
}

class SharePackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(ShareModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
