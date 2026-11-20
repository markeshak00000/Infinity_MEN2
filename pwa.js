(() => {
  "use strict";
  const DB_NAME = "infinity-men2-office";
  const STORE = "records";
  const APP_COLLECTIONS = new Set(["clients", "cases", "sessions", "documents", "tasks", "invoices", "settings"]);
  const native = window.InfinityNative && window.InfinityNative.isNative ? window.InfinityNative : null;
  let deferredInstallPrompt = null;
  let swRegistration = null;
  let statusEl = null;
  let sessionRefreshTimer = 0;
  let nativePushListenersReady = false;

  window.infinityCompressImage = (file) => new Promise((resolve, reject) => {
    if (!file || !file.type || !file.type.startsWith("image/")) return reject(new Error("ملف صورة غير صالح"));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("تعذرت قراءة الصورة"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("تعذر فتح الصورة"));
      img.onload = () => {
        const maxSide = 1600;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return reject(new Error("تعذر تجهيز الصورة"));
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  function setStatus(message) {
    if (statusEl) statusEl.textContent = message;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("التخزين المحلي غير مدعوم في هذا المتصفح"));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("تعذر فتح قاعدة البيانات"));
    });
  }

  async function getAllRecords() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }

  async function notify(title, body, tag) {
    if (!("Notification" in window) || Notification.permission !== "granted") return false;
    const reg = swRegistration || ("serviceWorker" in navigator ? await navigator.serviceWorker.ready : null);
    if (reg && reg.showNotification) {
      await reg.showNotification(title, {
        body,
        icon: "./assets/icon-192.png",
        badge: "./assets/icon-192.png",
        tag,
        dir: "rtl",
        lang: "ar",
        renotify: false,
        data: { url: "./index.html" }
      });
    } else {
      new Notification(title, { body, icon: "./assets/icon-192.png", tag, dir: "rtl", lang: "ar" });
    }
    return true;
  }

  async function requestWebNotifications() {
    if (!("Notification" in window)) {
      setStatus("هذا المتصفح لا يدعم إشعارات الويب. ثبّت التطبيق أو استخدم إصدار Android.");
      return false;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setStatus("لم يتم السماح بالإشعارات. يمكنك تغيير الإذن من إعدادات الجهاز أو المتصفح.");
      return false;
    }
    await notify("Infinity MEN2", "تم تفعيل الإشعارات على هذا الجهاز.", "infinity-notification-test");
    await trySubscribePush();
    await checkSessionReminders();
    setStatus("تم تفعيل إشعارات التطبيق على هذا الجهاز.");
    return true;
  }

  function positiveNotificationId(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) & 0x7fffffff || 1;
  }

  function getSessionReminderDate(item) {
    if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.date || ""))) return null;
    const hasTime = /^\d{2}:\d{2}$/.test(String(item.time || ""));
    const time = hasTime ? item.time : "08:00";
    const parts = time.split(":").map(Number);
    if (parts[0] > 23 || parts[1] > 59) return null;
    const appointment = new Date(`${item.date}T${time}:00`);
    if (Number.isNaN(appointment.getTime())) return null;
    // For timed sessions remind one hour early; when no time was entered use 8 AM.
    const reminder = new Date(appointment.getTime() - (hasTime ? 60 * 60 * 1000 : 0));
    return { reminder, appointment, hasTime };
  }

  async function scheduleNativeSessionReminders() {
    if (!native || !native.LocalNotifications) return;
    try {
      const plugin = native.LocalNotifications;
      const permission = await plugin.checkPermissions();
      if (permission.display !== "granted") return;
      const records = await getAllRecords();
      const now = new Date();
      const nextIds = [];
      const sessions = records.filter((record) => record.collection === "sessions");
      const upcoming = sessions.map((record) => {
        const item = record.value || {};
        const info = getSessionReminderDate(item);
        return info ? { record, item, info } : null;
      }).filter((entry) => entry && entry.info.reminder > now && entry.info.reminder.getTime() <= now.getTime() + 90 * 24 * 60 * 60 * 1000)
        .sort((a, b) => a.info.reminder - b.info.reminder)
        .slice(0, 60);
      const notifications = upcoming.map(({ record, item, info }) => {
        const id = positiveNotificationId(`${record.id}-${item.date}-${item.time || "08:00"}`);
        nextIds.push(id);
        const detail = [item.time ? `موعد الجلسة ${item.time}` : "موعد الجلسة 08:00", item.court, item.caseNumber ? `قضية ${item.caseNumber}` : ""].filter(Boolean).join(" • ");
        return {
          id,
          title: "تذكير جلسة قادمة",
          body: detail || "راجع تفاصيل الجلسة في التطبيق.",
          schedule: { at: info.reminder },
          smallIcon: "ic_stat_infinity",
          iconColor: "#D4AF37",
          extra: { recordId: record.id, date: item.date }
        };
      });
      const oldIds = JSON.parse(localStorage.getItem("infinity-men2-native-session-notification-ids") || "[]");
      if (Array.isArray(oldIds) && oldIds.length) {
        await plugin.cancel({ notifications: oldIds.filter(Number.isInteger).map((id) => ({ id })) });
      }
      if (notifications.length) await plugin.schedule({ notifications });
      localStorage.setItem("infinity-men2-native-session-notification-ids", JSON.stringify(nextIds));
    } catch (error) {
      console.warn("تعذر جدولة تذكيرات الجلسات الأصلية:", error);
      setStatus("تعذر تحديث تذكيرات الجلسات. راجع أذونات الإشعارات في إعدادات الجهاز.");
    }
  }

  async function requestNativeNotifications() {
    try {
      const plugin = native.LocalNotifications;
      let permission = await plugin.checkPermissions();
      if (permission.display !== "granted") permission = await plugin.requestPermissions();
      if (permission.display !== "granted") {
        setStatus("لم يتم السماح بالإشعارات. افتح إعدادات التطبيق في الهاتف وفعّل الإشعارات.");
        return;
      }
      await plugin.schedule({ notifications: [{
        id: 987650001,
        title: "Infinity MEN2",
        body: "تم تفعيل الإشعارات على هذا الجهاز بنجاح.",
        schedule: { at: new Date(Date.now() + 1800) },
        smallIcon: "ic_stat_infinity",
        iconColor: "#D4AF37"
      }] });
      await scheduleNativeSessionReminders();
      let pushStatus = "";
      try {
        const pushReady = await registerNativePush(true);
        pushStatus = pushReady
          ? " تم طلب التسجيل للإشعارات الخارجية أيضًا."
          : " الإشعارات الخارجية تحتاج إعداد Firebase وخادم Push.";
      } catch (pushError) {
        pushStatus = " التذكيرات المحلية تعمل؛ تعذر ربط الإشعارات الخارجية: " + (pushError.message || "تحقق من إعداد Firebase");
      }
      setStatus("تم تفعيل إشعارات الهاتف وجدولة تذكيرات الجلسات القادمة." + pushStatus);
    } catch (error) {
      setStatus("تعذر تفعيل إشعارات الهاتف: " + (error.message || "راجع أذونات الجهاز"));
    }
  }

  async function registerNativePush(requestPermission) {
    if (!native || !native.PushNotifications) return false;
    const plugin = native.PushNotifications;
    let permissions = await plugin.checkPermissions();
    if (permissions.receive !== "granted" && requestPermission) permissions = await plugin.requestPermissions();
    if (!permissions || permissions.receive !== "granted") return false;

    if (!nativePushListenersReady) {
      await plugin.addListener("registration", async (tokenResult) => {
        try {
          const token = tokenResult && tokenResult.value;
          if (!token) throw new Error("لم يتم استلام رمز الجهاز");
          localStorage.setItem("infinity-men2-fcm-token", token);
          const apiBase = (window.INFINITY_PUSH_API_URL || "").replace(/\/$/, "");
          if (!apiBase) {
            setStatus("تم تسجيل الجهاز لدى خدمة FCM. لربطه بخادم الإرسال الخارجي، اضبط عنوان الخدمة في config.js.");
            return;
          }
          if (!/^https:\/\//i.test(apiBase)) throw new Error("عنوان خادم الإشعارات يجب أن يبدأ بـ HTTPS");
          const response = await fetch(apiBase + "/api/fcm/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token, platform: native.platform === "ios" ? "ios" : "android" })
          });
          if (!response.ok) throw new Error("رفض خادم الإشعارات تسجيل هذا الجهاز");
          setStatus("تم تسجيل هذا الهاتف لاستقبال الإشعارات الخارجية.");
        } catch (error) {
          setStatus("تعذر تسجيل الجهاز في خادم الإشعارات: " + (error.message || "خطأ اتصال"));
        }
      });
      await plugin.addListener("registrationError", (error) => {
        console.warn("FCM registration failed:", error);
        setStatus("لم يكتمل تسجيل الإشعارات الخارجية. تحقق من ملف Firebase الخاص بتطبيق Android.");
      });
      await plugin.addListener("pushNotificationReceived", (notification) => {
        const title = notification && notification.title ? notification.title : "Infinity MEN2";
        const body = notification && notification.body ? notification.body : "وصلك إشعار جديد.";
        setStatus(title + " — " + body);
      });
      await plugin.addListener("pushNotificationActionPerformed", (action) => {
        const target = action && action.notification && action.notification.data && action.notification.data.url;
        if (typeof target === "string" && /^(\/|\.\/|index\.html$)/.test(target) && !target.startsWith("//")) {
          window.location.assign(target);
        }
      });
      nativePushListenersReady = true;
    }
    await plugin.register();
    return true;
  }

  async function requestNotifications() {
    if (native && native.LocalNotifications) return requestNativeNotifications();
    return requestWebNotifications();
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
  }

  async function trySubscribePush() {
    // Web Push needs an HTTPS deployment and the optional service in /server.
    const apiBase = (window.INFINITY_PUSH_API_URL || "").replace(/\/$/, "");
    if (!apiBase || !swRegistration || !("PushManager" in window)) {
      setStatus("إشعارات الويب المحلية مفعّلة. استقبال إشعار خارجي عند إغلاق التطبيق يحتاج نشر خدمة Push وإعداد عنوانها.");
      return;
    }
    try {
      const keyResponse = await fetch(apiBase + "/api/push/public-key");
      if (!keyResponse.ok) throw new Error("خادم الإشعارات غير متاح");
      const { publicKey } = await keyResponse.json();
      const subscription = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
      const saved = await fetch(apiBase + "/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription)
      });
      if (!saved.ok) throw new Error("تعذر تسجيل هذا الجهاز لخدمة الإشعارات");
      setStatus("هذا الجهاز مسجل لاستقبال إشعارات الويب الخارجية من خادم Push.");
    } catch (error) {
      setStatus("الإشعارات المحلية تعمل، لكن خادم Push غير متصل: " + (error.message || "خطأ اتصال"));
    }
  }

  const localDate = (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  async function checkSessionReminders() {
    if (native) return scheduleNativeSessionReminders();
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const records = await getAllRecords();
      const sessions = records.filter((record) => record.collection === "sessions");
      const now = new Date();
      const today = localDate(now);
      const tomorrowDate = new Date(now); tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      const tomorrow = localDate(tomorrowDate);
      const sentKey = "infinity-men2-session-notifications-" + today;
      const sent = new Set(JSON.parse(localStorage.getItem(sentKey) || "[]"));
      let sentCount = 0;
      for (const record of sessions) {
        const item = record.value || {};
        if (item.date !== today && item.date !== tomorrow) continue;
        const key = String(record.id) + "-" + String(item.date);
        if (sent.has(key)) continue;
        const when = item.date === today ? "اليوم" : "غدًا";
        const details = [item.time, item.court, item.caseNumber ? "قضية " + item.caseNumber : ""].filter(Boolean).join(" • ");
        await notify("تذكير جلسة " + when, details || "لديك جلسة مسجلة في التقويم.", "session-" + key);
        sent.add(key); sentCount += 1;
        if (sentCount >= 4) break;
      }
      localStorage.setItem(sentKey, JSON.stringify([...sent]));
    } catch (error) {
      console.warn("تعذر فحص تذكيرات الجلسات:", error);
    }
  }

  function installNativeCameraBridge() {
    if (!native || !native.Camera) return;
    document.addEventListener("click", async (event) => {
      const input = event.target && event.target.closest ? event.target.closest('input[type="file"][accept="image/*"][capture]') : null;
      if (!input || input.dataset.infinityCameraBusy === "1") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      input.dataset.infinityCameraBusy = "1";
      try {
        const photo = await native.Camera.getPhoto({
          quality: 82,
          width: 1800,
          allowEditing: true,
          resultType: native.CameraResultType.Uri,
          source: native.CameraSource.Camera
        });
        if (!photo || !photo.webPath) throw new Error("لم يتم استلام صورة من الكاميرا");
        const response = await fetch(photo.webPath);
        if (!response.ok) throw new Error("تعذر قراءة الصورة الملتقطة");
        const blob = await response.blob();
        const file = new File([blob], `document-${Date.now()}.jpg`, { type: blob.type || "image/jpeg" });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (error) {
        setStatus(error && error.message ? "تعذر فتح الكاميرا: " + error.message : "تم إلغاء التصوير.");
      } finally {
        delete input.dataset.infinityCameraBusy;
      }
    }, true);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function exportBackup() {
    try {
      const records = await getAllRecords();
      const backup = { app: "Infinity MEN2", formatVersion: 1, exportedAt: new Date().toISOString(), records };
      downloadBlob(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }), "infinity-men2-backup-" + new Date().toISOString().slice(0, 10) + ".json");
      setStatus("تم تجهيز نسخة احتياطية من " + records.length + " سجل.");
    } catch (error) {
      setStatus("تعذر إنشاء النسخة الاحتياطية: " + (error.message || "خطأ"));
    }
  }

  async function importBackup(file) {
    if (!file) return;
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error("حجم النسخة أكبر من الحد المسموح (100 ميجابايت)");
      const backup = JSON.parse(await file.text());
      if (backup.app !== "Infinity MEN2" || backup.formatVersion !== 1 || !Array.isArray(backup.records)) throw new Error("ملف النسخة الاحتياطية غير صالح");
      if (backup.records.length > 20000) throw new Error("عدد السجلات في النسخة يتجاوز الحد المسموح");
      if (!confirm("سيتم دمج " + backup.records.length + " سجلًا مع البيانات الموجودة. هل تريد المتابعة؟")) return;
      const db = await openDb();
      let imported = 0;
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          const store = tx.objectStore(STORE);
          for (const row of backup.records) {
            if (!row || typeof row.id !== "string" || typeof row.collection !== "string" || !APP_COLLECTIONS.has(row.collection) || !row.value || typeof row.value !== "object" || Array.isArray(row.value)) continue;
            store.put(row);
            imported++;
          }
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error("تم إلغاء الاستيراد"));
        });
      } finally { db.close(); }
      setStatus("تم استيراد " + imported + " سجل. سيتم تحديث شاشة البرنامج الآن.");
      setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      setStatus("تعذر استيراد النسخة: " + (error.message || "ملف غير صالح"));
    }
  }

  function createTools() {
    if (document.getElementById("infinity-pwa-tools")) return;
    const host = document.createElement("div");
    host.id = "infinity-pwa-tools";
    host.innerHTML = `
      <button id="infinity-pwa-toggle" type="button" aria-label="مركز التطبيق" title="مركز التطبيق">⚙</button>
      <section id="infinity-pwa-panel" aria-label="مركز التطبيق">
        <div class="infinity-pwa-brand"><img src="./assets/icon-192.png" alt="Infinity MEN2"><div><div class="infinity-pwa-title">مركز Infinity MEN2</div><div class="infinity-pwa-sub">التثبيت والإشعارات والنسخ الاحتياطي</div></div></div>
        <button class="infinity-pwa-action primary" id="infinity-install">تثبيت التطبيق على الهاتف</button>
        <button class="infinity-pwa-action" id="infinity-notifications">تفعيل إشعارات الجلسات</button>
        <button class="infinity-pwa-action" id="infinity-export">تصدير نسخة احتياطية</button>
        <button class="infinity-pwa-action" id="infinity-import-button">استعادة نسخة احتياطية</button>
        <input id="infinity-pwa-import" type="file" accept="application/json,.json">
        <div class="infinity-pwa-status" id="infinity-pwa-status">جارٍ تجهيز إمكانات الهاتف…</div>
      </section>`;
    document.body.appendChild(host);
    statusEl = document.getElementById("infinity-pwa-status");
    document.getElementById("infinity-pwa-toggle").addEventListener("click", () => document.getElementById("infinity-pwa-panel").classList.toggle("open"));
    document.getElementById("infinity-install").addEventListener("click", async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
      } else {
        setStatus("على Android: افتح قائمة Chrome واختر تثبيت التطبيق أو إضافة إلى الشاشة الرئيسية. على iPhone: مشاركة ثم Add to Home Screen.");
      }
    });
    document.getElementById("infinity-notifications").addEventListener("click", requestNotifications);
    document.getElementById("infinity-export").addEventListener("click", exportBackup);
    document.getElementById("infinity-import-button").addEventListener("click", () => document.getElementById("infinity-pwa-import").click());
    document.getElementById("infinity-pwa-import").addEventListener("change", (event) => {
      importBackup(event.target.files && event.target.files[0]);
      event.target.value = "";
    });
  }

  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstallPrompt = event; });
  window.addEventListener("appinstalled", () => setStatus("تم تثبيت Infinity MEN2 على الجهاز."));
  window.addEventListener("infinity:datachange", (event) => {
    if (!event.detail || event.detail.collection !== "sessions") return;
    clearTimeout(sessionRefreshTimer);
    sessionRefreshTimer = setTimeout(() => checkSessionReminders(), 700);
  });

  async function init() {
    createTools();
    installNativeCameraBridge();
    if (!native && "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
      try { swRegistration = await navigator.serviceWorker.register("./sw.js", { scope: "./" }); }
      catch (error) { console.warn("Service worker registration failed:", error); }
    }
    if (native) {
      setStatus("يعمل إصدار Android الأصلي. تحفظ البيانات على هذا الجهاز.");
      try {
        const permission = await native.LocalNotifications.checkPermissions();
        if (permission.display === "granted") await scheduleNativeSessionReminders();
        const pushPermission = await native.PushNotifications.checkPermissions();
        if (pushPermission.receive === "granted" && window.INFINITY_PUSH_API_URL) await registerNativePush(false);
      } catch (error) { console.warn("Native notification initialization:", error); }
    } else if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) setStatus("التطبيق يعمل الآن في وضع التثبيت.");
    else setStatus("يمكن تثبيت التطبيق من الزر أعلاه. تُحفظ بياناتك محليًا على هذا الجهاز.");
    checkSessionReminders();
    setInterval(checkSessionReminders, 15 * 60 * 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
