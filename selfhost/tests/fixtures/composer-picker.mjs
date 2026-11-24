import assert from "node:assert/strict";

export function composerPicker(page) {
  return page.getByTestId("prompt-suggestion-panel").and(page.locator('[data-trigger="+"]'));
}

/** The options outside the list's rendered window only mount after scrolling. */
export async function revealPickerOption(picker, optionId) {
  return revealPickerItem(picker, "prompt-suggestion-option-" + optionId);
}

export async function revealPickerItem(picker, testId) {
  await picker.getByRole("listbox").evaluate(async (list, id) => {
    const selector = '[data-testid="' + CSS.escape(id) + '"]';
    const paint = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    list.scrollTop = 0;
    await paint();
    for (;;) {
      const option = list.querySelector(selector);
      if (option) {
        option.scrollIntoView({ block: "nearest" });
        await paint();
        return;
      }
      const previous = list.scrollTop;
      list.scrollTop += Math.max(34, list.clientHeight - 34);
      if (list.scrollTop === previous) return;
      await paint();
    }
  }, testId);
  const option = picker.getByTestId(testId);
  assert.equal(await option.count(), 1, `Picker item ${testId} is missing or ambiguous.`);
  return option;
}
