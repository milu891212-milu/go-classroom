/*
 * 連線設定。firebase 是 null 的時候，整個網頁就是單機版（兩人共用一台裝置）。
 *
 * 填入 Firebase 專案的設定之後，開啟網頁會先出現登入畫面。
 * 這裡的 firebase 設定值不是密碼，放在網頁裡是正常的；真正的保護來自
 * 「只有後台建立的帳號能登入」與資料庫規則（database.rules.json）。
 */
window.GO_CONFIG = {
  // 從 Firebase 後台「專案設定 → 你的應用程式」複製的 firebaseConfig，整段貼在這裡取代 null
  firebase: {
    apiKey: "AIzaSyCs0pOfJknRfKF9dt3V92NgB3cq6jvwTCM",
    authDomain: "go-classroom-fc336.firebaseapp.com",
    databaseURL: "https://go-classroom-fc336-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "go-classroom-fc336",
    storageBucket: "go-classroom-fc336.firebasestorage.app",
    messagingSenderId: "777176195521",
    appId: "1:777176195521:web:2d844c6415fccab9ea4f40"
  },

  // 登入時只要輸入帳號名稱（例如 teacher），程式會自動補上 @ 後面這一段
  // （Firebase 的帳號必須是電子郵件格式，這個網域只是湊格式用，不會真的寄信）
  accountDomain: 'goclass.example.com',

  // 哪些帳號是老師（其餘都是學生）。要與 database.rules.json 裡列出的帳號一致
  teachers: ['teacher'],

  // 對局室名稱，一般不用改
  room: 'main'
};
