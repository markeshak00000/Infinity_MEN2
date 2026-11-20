import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';

// One bridge keeps the existing standalone HTML application compatible with
// browser/PWA builds and the Android native WebView.
window.InfinityNative = Object.freeze({
  isNative: Capacitor.isNativePlatform(),
  platform: Capacitor.getPlatform(),
  Camera,
  CameraResultType,
  CameraSource,
  LocalNotifications,
  PushNotifications,
});
