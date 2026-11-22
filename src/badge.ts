import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AdblockStatus } from "./types";

const badge = document.getElementById("badge")!;
const label = document.getElementById("label")!;
const detail = document.getElementById("detail")!;

let fadeTimer: number | undefined;
let hideTimer: number | undefined;

function hide() {
  badge.classList.remove("visible");
  hideTimer = window.setTimeout(() => void invoke("badge_hide"), 450);
}

function setStatus(status: AdblockStatus) {
  window.clearTimeout(fadeTimer);
  window.clearTimeout(hideTimer);
  badge.className = `badge ${status.level} visible`;
  label.textContent = status.label;
  detail.textContent = status.detail;
  // warnings stay a little longer; "Finding ad-free stream" is replaced once a proxy is found
  const delay = { ok: 6000, warn: 12000, info: 30000 }[status.level];
  fadeTimer = window.setTimeout(hide, delay);
}

badge.addEventListener("click", hide);
void listen<AdblockStatus>("badge-status", (event) => setStatus(event.payload));
