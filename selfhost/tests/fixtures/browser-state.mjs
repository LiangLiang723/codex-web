export function browserStateFixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  return (route) => {
    if (route.request().method() === "PATCH") {
      const { changes, importLegacy } = route.request().postDataJSON();
      for (const [key, value] of changes) {
        if (!importLegacy || !values.has(key)) values.set(key, value);
      }
    }
    return route.fulfill({
      json: Object.fromEntries([...values].filter(([, value]) => value !== null)),
    });
  };
}

export function waitForBrowserStateWrite(page, matches) {
  return page.waitForResponse((response) =>
    response.ok() &&
    new URL(response.url()).pathname === "/api/selfhost/browser-state" &&
    response.request().method() === "PATCH" &&
    response.request().postDataJSON().changes.some(([key, value]) => matches(key, value)),
  );
}
