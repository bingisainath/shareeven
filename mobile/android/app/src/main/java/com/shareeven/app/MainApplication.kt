package com.shareeven.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
          add(NotificationsPackage()) // clears read chats from the notification shade
          add(SharePackage()) // "Share to ShareEven" from other apps
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    createNotificationChannels()
  }

  /** The server sends chat notifications to the "messages" channel (backend/app/services/push.py). */
  private fun createNotificationChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel("messages", "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "New messages in your chats"
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }
}
