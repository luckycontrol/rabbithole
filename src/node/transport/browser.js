import { execFile } from "node:child_process";
import { warn } from "../logger.js";

/**
 * Opens a URL in the default browser. `open` on macOS, `start` on Windows,
 * `xdg-open` elsewhere.
 */
export function openBrowser(url) {
  if (process.env.RABBITHOLE_NO_BROWSER) {
    warn(`RABBITHOLE_NO_BROWSER set — not opening: ${url}`);
    return;
  }

  let cmd;
  let args;

  switch (process.platform) {
    case "darwin":
      cmd = "open";
      args = [url];
      break;
    case "win32":
      cmd = "cmd";
      args = ["/c", "start", "", url];
      break;
    default:
      cmd = "xdg-open";
      args = [url];
      break;
  }

  execFile(cmd, args, (err) => {
    if (err) {
      warn(`Failed to open browser: ${err.message}`);
      warn(`Please open manually: ${url}`);
    }
  });
}
