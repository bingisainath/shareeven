package com.shareeven.app

import android.view.View
import android.view.ViewTreeObserver
import android.widget.EditText
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import java.lang.ref.WeakReference
import java.util.WeakHashMap

/**
 * Pasting images and files into the chat's message box: long-press → Paste, the keyboard's clipboard,
 * or an image or GIF the keyboard offers. A React Native text box only takes text, so this hooks
 * Android's OnReceiveContentListener onto the message box (the TextInput with nativeID "message-input")
 * when it gets focus. Files are copied into the cache like shared ones (ShareModule.copyToCache) and
 * handed to the app as the "ShareEvenPasted" event ({ files: [{ uri, type, name, size }] }), which
 * adds them as attachments (src/components/chat/Composer.tsx). Pasted text is left to the text box.
 */
class PasteModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "ShareEvenPaste"

  private var watching: WeakReference<View>? = null
  private val hooked = WeakHashMap<EditText, Boolean>()

  private val receiver = OnReceiveContentListener { _, payload ->
    val split = payload.partition { it.uri != null }
    val files: ContentInfoCompat? = split.first
    val rest: ContentInfoCompat? = split.second
    if (files != null) {
      Thread {
        // Read from `files` here, so it stays referenced until the copies are made: a keyboard's read
        // permission for its image lasts as long as that object does
        val clip = files.clip
        val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.take(MAX_FILES)
        val fallbackType = if (clip.description.mimeTypeCount > 0) clip.description.getMimeType(0) else null
        val copied = Arguments.createArray()
        for (uri in uris) {
          try {
            ShareModule.copyToCache(reactApplicationContext, uri, FOLDER, fallbackType)?.let { copied.pushMap(it) }
          } catch (e: Exception) {
            // unreadable (the other app took its permission back): skipped
          }
        }
        if (copied.size() > 0) {
          reactApplicationContext.emitDeviceEvent(EVENT_PASTED, Arguments.createMap().apply { putArray("files", copied) })
        }
      }.start()
    }
    rest // text pastes as usual
  }

  private val onFocus = ViewTreeObserver.OnGlobalFocusChangeListener { _, focused -> hook(focused) }

  private fun hook(view: View?) {
    if (view !is EditText || hooked.containsKey(view)) return
    if (view.getTag(com.facebook.react.R.id.view_tag_native_id) != NATIVE_ID) return
    ViewCompat.setOnReceiveContentListener(view, MIME_TYPES, receiver)
    hooked[view] = true
  }

  /** Called when a chat's message box appears; safe to call again (a new activity is watched too). */
  @ReactMethod
  fun enable() {
    UiThreadUtil.runOnUiThread {
      val decor = reactApplicationContext.currentActivity?.window?.decorView ?: return@runOnUiThread
      if (watching?.get() !== decor) {
        decor.viewTreeObserver.addOnGlobalFocusChangeListener(onFocus)
        watching = WeakReference(decor)
      }
      hook(decor.findFocus())
    }
  }

  // For NativeEventEmitter
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  companion object {
    const val EVENT_PASTED = "ShareEvenPasted"
    const val NATIVE_ID = "message-input"
    private const val FOLDER = "pasted"
    private const val MAX_FILES = 10
    // What the keyboard is told the box accepts (images, GIFs, videos, documents)
    private val MIME_TYPES = arrayOf("image/*", "video/*", "audio/*", "application/*", "text/csv")
  }
}
