# دليل التشغيل السحابي المجاني (GitHub Actions + cron-job.org) ☁️⚽

البوت يعمل بالكامل من السحابة **بدون الحاجة لفتح جهازك أبداً** كل يوم أحد الساعة **1:00:00 الظهر بالظبط** ويرسل **`ناجى`** في جروب **`ليالى NHC الكرويه`**.

---

## الخطوة 1: مسح الـ QR مرة واحدة فقط لتوليد الجلسة المشفرة
1. افتح ملف **`1-setup-cloud-qr.bat`** (أو شغّل `npm run setup`).
2. امسح كود الـ QR من موبايلك (**واتساب ← الأجهزة المرتبطة ← ربط جهاز**).
3. البوت هيتعرف تلقائياً على جروب **`ليالى NHC الكرويه`**، وينشئ ملف الجلسة المشفر **`session.enc`**، ويطبعلك مفتاح فك التشفير السري **`SESSION_KEY`** (وبيحفظهولك برضه في `session-key.txt`).

---

## الخطوة 2: رفع المشروع على مستودع خاص (Private Repo) في GitHub
1. ادخل على [github.com/new](https://github.com/new) واعمل مستودع جديد باسم مثلاً `whatsapp-nhc-bot` وتأكد إنه **Private (خاص)**.
2. ارفع ملفات المجلد للمستودع (أو ابعتلي رابط المستودع وأنا أرفعهولك فوراً بأمر واحد).
3. في صفحة المستودع على GitHub افتح:
   **Settings → Secrets and variables → Actions → New repository secret**
   - **Name:** `SESSION_KEY`
   - **Secret:** الصق الكود المكون من 64 حرف الموجود في `session-key.txt`.
4. للتجربة السحابية فوراً: افتح تبويب **Actions** في المستودع ← اختر **Sunday 1PM WhatsApp NHC Sender** ← اضغط **Run workflow** واختر `test-me` ← في خلال 15 ثانية هتوصلك رسالة **`ناجى (تجربة سحابية ناجحة ✅)`** على موبايلك من السحابة!

---

## الخطوة 3: ربط cron-job.org لضمان الاستيقاظ الساعة 12:56 بالثانية
*(يوجد بالفعل كرون احتياطي مدمج داخل GitHub Actions الساعة 12:42، وربط cron-job.org يضمن الدقة التامة بلا أي تأخير من GitHub)*:

1. من حسابك في GitHub افتح [Fine-grained Personal Access Tokens](https://github.com/settings/personal-access-tokens/new):
   - اختر المستودع `whatsapp-nhc-bot` فقط (**Only select repositories**).
   - من **Repository permissions** اجعل صلاحية **Actions** = **Read and write**، واضغط **Generate token** وانسخه.
2. سجل حساب مجاني على [console.cron-job.org](https://console.cron-job.org) واضغط **Create Cronjob**:
   - **Title:** `NHC Sunday 1PM WhatsApp`
   - **URL:**
     `https://api.github.com/repos/YOUR_GITHUB_USERNAME/whatsapp-nhc-bot/actions/workflows/sunday-whatsapp.yml/dispatches`
   - **Execution schedule:** كل يوم **أحد (Sunday)** الساعة **12:56** (وتأكد أن التوقيت في الإعدادات `Asia/Riyadh` أو التوقيت المحلي `+03:00`).
   - افتح تبويب **Advanced**:
     - **Request method:** `POST`
     - **Headers:** أضف 3 ترويسات:
       1. `Accept` : `application/vnd.github+json`
       2. `Authorization` : `Bearer YOUR_GITHUB_TOKEN`
       3. `Content-Type` : `application/json`
     - **Request body:**
       ```json
       {"ref":"main","inputs":{"mode":"live"}}
       ```
   - اضغط **Create**!
