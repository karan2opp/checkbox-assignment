const container = document.querySelector(".container");
const loginBtn = document.getElementById("loginBtn");
const signupBtn = document.getElementById("signupBtn");
const logoutBtn = document.getElementById("logoutBtn");

const API_URL = CONFIG.API_URL;

let start = 0;
const limit = 700;
const TOTAL = 1_000_000;

// ✅ socket with config
const socket = io(API_URL, {
  withCredentials: true,
});

const inputs = [];
let isLoading = false;
let isBlocked = false;
let isLoggedIn = false;

// 🔐 check auth
async function checkAuth() {
  try {
    const res = await fetch(`${API_URL}/api/auth/me`, {
      credentials: "include",
    });

    if (res.ok) {
      isLoggedIn = true;
      loginBtn.style.display = "none";
      signupBtn.style.display = "none";
      logoutBtn.style.display = "block";
    } else {
      isLoggedIn = false;
    }
  } catch (err) {
    console.log("Not logged in");
  }
}

// 🔑 login/signup
loginBtn.addEventListener("click", () => {
  window.location.href = `${API_URL}/auth/login`;
});

signupBtn.addEventListener("click", () => {
  window.location.href = `http://localhost:8006/auth/register`;
});

// 🚪 logout
logoutBtn.addEventListener("click", async () => {
  await fetch(`${API_URL}/api/auth/logout`, {
    method: "POST",
    credentials: "include",
  });

  isLoggedIn = false;

  loginBtn.style.display = "block";
  signupBtn.style.display = "block";
  logoutBtn.style.display = "none";
});

// 🔔 notification
function showNotification(message) {
  const notif = document.createElement("div");
  notif.className = "notification";
  notif.textContent = message;

  document.body.appendChild(notif);

  setTimeout(() => {
    notif.classList.add("hide");
    setTimeout(() => notif.remove(), 300);
  }, 2000);
}

// 📦 load checkboxes
async function loadMore() {
  if (isLoading || start >= TOTAL) return;

  isLoading = true;

  const res = await fetch(
    `${API_URL}/state?start=${start}&limit=${limit}`,
    {
      credentials: "include", // ✅ important
    }
  );

  const json = await res.json();
  const state = json.data;

  state.forEach((value, i) => {
    const globalIndex = start + i;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value;

    container.appendChild(input);
    inputs[globalIndex] = input;

    input.addEventListener("change", () => {
      // 🔐 block if not logged in
      if (!isLoggedIn) {
        showNotification("Please login first");
        input.checked = !input.checked;
        return;
      }

      if (isBlocked) {
        input.checked = !input.checked;
        return;
      }

      socket.emit("checkbox_update", {
        index: globalIndex,
        checked: input.checked,
      });
    });
  });

  start += limit;
  isLoading = false;
}

// 🔄 socket sync
socket.on("checkbox_update", ({ index, checked }) => {
  if (inputs[index]) {
    inputs[index].checked = checked;
  }
});

// ⛔ rate limit
socket.on("rate_limited", (data) => {
  isBlocked = true;

  showNotification(data.message || "Too many requests");

  setTimeout(() => {
    isBlocked = false;
  }, 5000);
});

// 📜 scroll
window.addEventListener("scroll", () => {
  if (start >= TOTAL) return;

  if (
    window.innerHeight + window.scrollY >=
    document.body.offsetHeight - 200
  ) {
    loadMore();
  }
});

// 🚀 init
window.addEventListener("load", async () => {
  await checkAuth();
  loadMore();
});