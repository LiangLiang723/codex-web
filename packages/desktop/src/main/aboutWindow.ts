interface CustomAboutDialogHtmlInput {
  applicationName: string;
  appVersion: string;
  copyright: string;
  optimizationLine: string;
  versionLabel: string;
  okButtonLabel: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createCustomAboutDialogHtml(input: CustomAboutDialogHtmlInput): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    />
    <title>${escapeHtml(input.applicationName)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        --startup-page-bg: #f4f4f5;
        --about-primary: #0a0a0a;
        --about-primary-foreground: #fafafa;
        --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: var(--startup-page-bg);
      }

      body {
        display: grid;
        place-items: center;
        padding: 0;
        user-select: none;
      }

      .about-window {
        width: 100%;
        max-width: 256px;
        height: 280px;
        display: grid;
        place-items: stretch;
        padding: 0;
        background: transparent;
      }

      .about-card {
        width: 100%;
        height: 100%;
        padding: 22px 15px 14px;
        display: flex;
        flex-direction: column;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #1d1d1f;
        box-shadow: none;
        -webkit-app-region: drag;
      }

      .content {
        width: 100%;
        max-width: 222px;
        margin: 0 auto;
        flex: 1;
        min-height: 0;
      }

      .app-icon {
        width: 52px;
        height: 52px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        background: var(--startup-page-bg);
        color: light-dark(#161616, #fff);
        box-shadow: 0 10px 13px -3px rgb(0 0 0 / 0.2), 0 4px 5px -3px rgb(0 0 0 / 0.2);
      }

      .app-logo {
        width: 30px;
        height: auto;
        display: block;
      }

      .title {
        margin: 20px 0 0;
        font-size: 13.5px;
        line-height: 1.18;
        font-weight: 700;
        letter-spacing: 0;
      }

      .meta {
        margin-top: 28px;
        display: flex;
        flex-direction: column;
        gap: 17px;
        font-size: 13px;
        line-height: 1.2;
        font-weight: 400;
        letter-spacing: 0;
        color: #303033;
      }


      .ok-button {
        width: 100%;
        height: 36px;
        border: 0;
        border-radius: 18px;
        background: var(--about-primary);
        color: var(--about-primary-foreground);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0;
        outline: none;
        cursor: default;
        -webkit-app-region: no-drag;
      }

      .ok-button:active {
        background: var(--about-primary-active);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --startup-page-bg: #171717;
          --about-primary: #fafafa;
          --about-primary-foreground: #0a0a0a;
          --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
        }

        .about-card {
          color: #e8e8e8;
        }

        .meta {
          color: #e2e2e2;
        }
      }
    </style>
  </head>
  <body>
    <main class="about-window" aria-label="${escapeHtml(input.applicationName)} About Window">
      <section class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class="content">
          <div class="app-icon" aria-hidden="true">
            <svg viewBox="0 0 64 64" class="app-logo" aria-hidden="true" focusable="false">
              <path fill="currentColor" fill-rule="evenodd" d="M57.70,29.99Q58.00,32.00 57.98,34.06Q57.96,36.11 57.58,38.15Q57.21,40.19 56.46,42.14Q55.72,44.08 54.61,45.86Q53.51,47.63 52.11,49.16Q50.70,50.70 49.05,51.94Q47.40,53.19 45.58,54.13Q43.76,55.08 41.84,55.73Q39.92,56.38 37.95,56.75Q35.98,57.13 33.99,57.25Q32.00,57.38 30.01,57.25Q28.02,57.13 26.05,56.75Q24.08,56.38 22.16,55.73Q20.24,55.08 18.42,54.13Q16.60,53.19 14.95,51.94Q13.30,50.70 11.89,49.16Q10.49,47.63 9.39,45.86Q8.28,44.08 7.54,42.14Q6.79,40.19 6.42,38.15Q6.04,36.11 6.02,34.06Q6.00,32.00 6.30,29.99Q6.60,27.98 7.18,26.05Q7.75,24.12 8.57,22.30Q9.38,20.48 10.41,18.77Q11.45,17.07 12.69,15.50Q13.93,13.93 15.38,12.52Q16.83,11.12 18.49,9.93Q20.15,8.75 22.00,7.84Q23.85,6.92 25.85,6.35Q27.85,5.77 29.92,5.57Q32.00,5.38 34.08,5.57Q36.15,5.77 38.15,6.35Q40.15,6.92 42.00,7.84Q43.85,8.75 45.51,9.93Q47.17,11.12 48.62,12.52Q50.07,13.93 51.31,15.50Q52.55,17.07 53.59,18.77Q54.62,20.48 55.43,22.30Q56.25,24.12 56.82,26.05Q57.40,27.98 57.70,29.99ZM32.20,34.12Q31.94,35.11 31.37,36.02Q30.80,36.93 30.03,37.59Q29.27,38.24 28.48,38.51Q27.68,38.78 27.02,38.61Q26.35,38.45 25.95,37.88Q25.55,37.32 25.50,36.46Q25.44,35.60 25.72,34.62Q26.01,33.64 26.58,32.73Q27.15,31.81 27.89,31.15Q28.63,30.48 29.40,30.20Q30.17,29.92 30.82,30.08Q31.48,30.24 31.89,30.81Q32.30,31.39 32.39,32.26Q32.47,33.13 32.20,34.12ZM45.65,29.77Q45.45,30.80 44.97,31.75Q44.49,32.71 43.83,33.42Q43.17,34.12 42.47,34.44Q41.77,34.75 41.17,34.62Q40.57,34.48 40.20,33.93Q39.83,33.38 39.75,32.51Q39.67,31.64 39.90,30.63Q40.12,29.62 40.60,28.66Q41.08,27.70 41.71,26.99Q42.35,26.27 43.02,25.94Q43.69,25.61 44.28,25.74Q44.87,25.87 45.26,26.43Q45.64,26.99 45.75,27.87Q45.86,28.75 45.65,29.77Z" />
            </svg>
          </div>
          <h1 id="about-title" class="title">
            ${escapeHtml(input.applicationName)}<br />
            ${escapeHtml(input.versionLabel)} ${escapeHtml(input.appVersion)}
          </h1>
          <div class="meta">
            ${input.optimizationLine ? `<div>${escapeHtml(input.optimizationLine)}</div>` : ""}
            <div>${escapeHtml(input.copyright)}</div>
          </div>
        </div>
        <div class="spacer"></div>
        <button class="ok-button" type="button" autofocus>${escapeHtml(input.okButtonLabel)}</button>
      </section>
    </main>
    <script>
      const closeWindow = () => window.close();
      document.querySelector(".ok-button")?.addEventListener("click", closeWindow);
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" || event.key === "Enter") {
          closeWindow();
        }
      });
    </script>
  </body>
</html>`;
}
