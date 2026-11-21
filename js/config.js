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

  // 教室分配：每間教室一位老師配幾個學生帳號，不同教室互相看不到對方的棋，可以同時上課。
  // 沒有列在這裡的帳號登入時會被擋下。
  // 改了這裡，database.rules.json 也要跟著改（每間教室列出同樣的帳號），再貼到 Firebase 後台發布。
  // 語音連線用的伺服器。預設只用 Google 的免費 STUN；如果有學生的網路（例如部分手機 4G）一直「連不上」，
  // 可以在這裡加一組 TURN 轉接伺服器，例如 { urls: 'turn:主機:3478', username: '帳號', credential: '密碼' }。
  voice: {
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
  },

  // 暱稱：登入用英文帳號，畫面上顯示這裡的名字（聊天室、在線名單、學生列表、語音、答題統計…）。
  // 沒列在這裡的帳號就直接顯示帳號名稱；老師沒設定暱稱時顯示「老師」。
  names: {
    // student1: '小明',
  },

  rooms: [
    { id: 'main',  teacher: 'teacher',  students: ['student1'] },
    { id: 'room2', teacher: 'teacher2', students: ['student2'] }
  ]
};
