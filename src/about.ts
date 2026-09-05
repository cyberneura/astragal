import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";

interface AppInfo {
  name: string;
  version: string;
  description: string;
  repository_url: string;
  vendor_name: string;
  vendor_url: string;
}

/**
 * links.ts と同じ理由で window.open は使えない (WKWebView が null を返す)。
 * 既定のブラウザに渡す。
 */
function bindExternalLink(anchor: HTMLAnchorElement, url: string): void {
  anchor.href = url;
  anchor.title = url;
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    openUrl(url).catch((error: unknown) => {
      console.error(`astragal: could not open ${url}`, error);
    });
  });
}

function render(info: AppInfo): void {
  document.getElementById("about-name")!.textContent = info.name;
  document.getElementById("about-version")!.textContent = `Version ${info.version}`;
  document.getElementById("about-description")!.textContent = info.description;
  bindExternalLink(
    document.getElementById("about-repository") as HTMLAnchorElement,
    info.repository_url,
  );
  const vendor = document.getElementById("about-vendor") as HTMLAnchorElement;
  vendor.textContent = info.vendor_name;
  bindExternalLink(vendor, info.vendor_url);
  document.getElementById("about-copyright")!.textContent =
    `© ${new Date().getFullYear()} ${info.vendor_name}`;
}

window.addEventListener("load", async () => {
  try {
    render(await invoke<AppInfo>("app_info"));
  } catch (e) {
    console.error("astragal: failed to load app info", e);
  }
  // DOM を埋めてからウインドウを出してもらう (白い初期背景を見せないため)。
  // requestAnimationFrame は使わない。WebKit は非表示のページではフレームを止めるので、
  // 表示待ちの中で描画を待つと永遠に出ない。
  invoke("about_window_ready").catch((e: unknown) => {
    console.error("astragal: failed to show the about window", e);
  });

  // Cmd+W は既定のアプリメニューの Close Window が拾うので不要。Esc だけ自前で閉じる。
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void getCurrentWebviewWindow().close();
    }
  });
});
