# Show a web page with Goga Desktop

Use a demonstration to share a live prototype, diagram, or other web page in a project. You can drive the page yourself, open a separate viewer, or let a trusted agent drive it. You do not need a pipeline, Docker, Git, or a separate browser installation to start a local demonstration.

## Open a page

1. Select the project and topic where the page belongs, or **No topic** for the original project folder.
2. Choose **Launch → Start demonstration**. Enter a full HTTP or HTTPS URL in the address bar and press Enter. For a prototype on disk, start its local HTTP server and enter its URL; the bundled browser does not open `file://` paths.
3. Use **Reload page** to refresh the current tab. The address bar follows navigation; Esc cancels an address you have not submitted. The copy icon copies the URL of the open page, not the text you are still typing. In a narrow view, use the link icon to reveal the address bar.
4. To view the same page in your usual browser, choose **Open in browser** from the demonstration. Use this action rather than opening the agent port in a browser.

Use **+** to open a page tab. Close a page with the **× on that tab**; closing the last page opens a blank one. Close the **main Demonstration tab** to end the whole demonstration. Leaving the expanded view does not end it. You can scroll the tab strip horizontally or use the arrow, Home, and End keys.

Each project or topic working context gets its own temporary browser profile and tabs. Opening a second demonstration does not expose the first one's pages or automatically move its agent.

## Connect a trusted agent

**The agent port has no access key.** The first client to connect gains control. Use it only with trusted local agents or containers, and do not expose it to a public or shared network. Separate profiles keep demonstrations apart; they do not protect the computer from an untrusted browser automation client.

Under **Settings → Demonstration**, set the agent port before starting the demonstration. The default is `45123`. Saving the setting does not open the port; starting the first demonstration does. To change a port that is in use, end the demonstration that owns it first.

| Where the agent runs | Address for Playwright's `chromium.connectOverCDP` |
| --- | --- |
| On the same computer | `http://127.0.0.1:45123` |
| In Docker Desktop | `http://host.docker.internal:45123` |

Substitute your configured port in either address. To show a page created by the agent, bring the page to the front with Playwright's `page.bringToFront()` or CDP's `Target.activateTarget`. Creating a tab alone does not switch the viewer to it. If the agent disconnects, the last selected page remains visible: **Waiting for agent** does not mean the content is gone.

- **Transfer control** disconnects the current client so the next agent can take over the same page without reloading it. Disable the old client's automatic reconnection first.
- **Switch port to this demonstration** moves the connection to another open context. The previous client sessions lose access; both demonstrations keep their pages. The agent indicator's tooltip identifies the port owner.

## Select text and change browsers

Drag to select text and use **⌘C / Ctrl+C** or **right-click → Copy**. Only the active tab's selection is copied; password fields are excluded. An empty selection leaves the clipboard unchanged. If an embedded document's selection cannot be read safely, Desktop reports that rather than copying text from another page. This action does not give the agent access to the system clipboard.

The default browser is bundled Chromium. The bundled mode does not grant web pages system permissions or allow an agent to fill a file upload with a path from your computer. If you need special Playwright context options such as a custom proxy, choose **Settings → Demonstration → Demonstration browser → System browser**. On macOS this looks for Chrome, Chromium, or Edge in Applications. The choice applies to new demonstrations only. If bundled Chromium cannot start, **Launch in the system browser** retries once without changing your preference.

## Why the viewer can look different from the agent's screenshot

Desktop streams the most recent PNG frame from the active page. To preserve aspect ratio and limit bandwidth, the viewer may scale it to fit within 2250 × 1300 pixels without resizing the agent's page. Hidden viewers stop requesting frames; capture stops when there are no viewers. When streaming is unavailable, Desktop falls back to periodic snapshots of the same page. Viewing does not need the agent port.

[Back to Goga Desktop](../README.md)
