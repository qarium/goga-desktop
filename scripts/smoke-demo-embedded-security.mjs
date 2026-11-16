// Only invoked by the disposable smoke worker. Test file paths, permission
// origins and download destination must never point into a user's real profile.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function assertEmbeddedSecurity({ wire, origin, tmp }) {
  assert.equal(await fs.realpath(process.cwd()), await fs.realpath(tmp));
  const file = path.join(tmp, "private-test-document.html");
  await fs.writeFile(file, randomUUID(), { flag: "wx" });
  const url = pathToFileURL(file).href;
  const dir = await fs.mkdtemp(path.join(tmp, "download-test-"));
  const rejected = (e) => e?.protocol === true;

  await assert.rejects(wire.send("Target.attachToBrowserTarget"), rejected);
  await assert.rejects(wire.send("Target.createTarget", { url }), rejected);
  await wire.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: dir,
  });
  const { browserContextId } = await wire.send("Target.createBrowserContext");
  try {
    for (const ctx of [{}, { browserContextId }]) {
      const { targetId } = await wire.send("Target.createTarget", {
        ...ctx,
        url: "about:blank",
      });
      try {
        const { sessionId } = await wire.send("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const send = (method, params = {}) =>
          wire.send(method, params, sessionId);
        const evaluate = async (expression) => {
          const r = await send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          assert.equal(
            r.exceptionDetails,
            undefined,
            "Script on synthetic webpage failed",
          );
          return r.result.value;
        };
        assert.ok(
          !(await send("Page.navigate", { url: origin + "/blue" })).errorText,
        );
        let loaded = false;
        for (let i = 0; i < 80; i++) {
          if (
            await evaluate('document.title === "Demo blue" && !!document.body')
          ) {
            loaded = true;
            break;
          }
          await delay(25);
        }
        assert.ok(loaded, "Test page was not loaded");
        assert.deepEqual(
          await evaluate(
            "[typeof window.goga, typeof window.require, typeof window.process, typeof window.electron]",
          ),
          ["undefined", "undefined", "undefined", "undefined"],
        );
        assert.equal(
          await evaluate("Notification.requestPermission()"),
          "denied",
          "Unexpected permission grant or prompt",
        );
        await evaluate(
          'const input=document.createElement("input");input.type="file";input.id="probe-file";document.body.append(input);true',
        );
        const { root } = await send("DOM.getDocument");
        const { nodeId } = await send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: "#probe-file",
        });
        await assert.rejects(
          send("DOM.setFileInputFiles", { nodeId, files: [file] }),
          rejected,
        );
        assert.equal(
          await evaluate('document.getElementById("probe-file").files.length'),
          0,
        );
        // Agent cannot grant itself a writable path, even inside its own context.
        await evaluate(
          'const link=document.createElement("a");link.download="test-download.txt";link.href=URL.createObjectURL(new Blob(["temporary smoke file"]));link.click();true',
        );
        await delay(250);
        const blocked = await send("Page.navigate", { url }).then(
          (r) => !!r.errorText,
          (e) => {
            if (!rejected(e)) throw e;
            return true;
          },
        );
        assert.ok(blocked, "Local file navigation succeeded");
      } finally {
        await wire.send("Target.closeTarget", { targetId });
      }
    }
    assert.deepEqual(
      await fs.readdir(dir),
      [],
      "Agent-enabled download wrote to disk",
    );
  } finally {
    await wire.send("Target.disposeBrowserContext", { browserContextId });
  }
}
