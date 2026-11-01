import {
  applySuggestion,
  findTrigger,
  suggest,
  type Suggestion,
  type SuggestionSources,
} from "./autocomplete.js";
import { renderMarkdown } from "./markdown.js";

/**
 * Upgrades a plain `<textarea>` in place into a Write/Preview editor with
 * `#` (issues), `@` (users) and `~` (labels) autocompletion. The textarea
 * keeps its id and value, so code that reads `textarea.value` is unchanged.
 */
export function enhanceMarkdownEditor(
  textarea: HTMLTextAreaElement,
  getSources: () => SuggestionSources,
): void {
  const wrapper = document.createElement("div");
  wrapper.className = "md-editor";

  const tabs = document.createElement("div");
  tabs.className = "md-tabs";
  tabs.setAttribute("role", "tablist");
  const writeTab = makeTab("Write", true);
  const previewTab = makeTab("Preview", false);
  tabs.append(writeTab, previewTab);

  const preview = document.createElement("div");
  preview.className = "md-preview";
  preview.hidden = true;
  preview.setAttribute("aria-label", "Markdown preview");

  const list = document.createElement("ul");
  list.className = "md-suggestions";
  list.setAttribute("role", "listbox");
  list.hidden = true;

  textarea.replaceWith(wrapper);
  wrapper.append(tabs, textarea, preview, list);

  const showPreview = (on: boolean): void => {
    writeTab.setAttribute("aria-selected", String(!on));
    previewTab.setAttribute("aria-selected", String(on));
    textarea.hidden = on;
    preview.hidden = !on;
    list.hidden = true;
    if (on) {
      preview.innerHTML = renderMarkdown(textarea.value);
    }
  };
  writeTab.addEventListener("click", () => showPreview(false));
  previewTab.addEventListener("click", () => showPreview(true));

  let suggestions: Suggestion[] = [];
  let active = 0;

  const hide = (): void => {
    list.hidden = true;
    suggestions = [];
  };
  const accept = (suggestion: Suggestion): void => {
    const caret = textarea.selectionStart;
    const match = findTrigger(textarea.value, caret);
    if (!match) {
      return;
    }
    const result = applySuggestion(textarea.value, caret, match, suggestion);
    textarea.value = result.text;
    textarea.setSelectionRange(result.caret, result.caret);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    hide();
    textarea.focus();
  };
  const render = (): void => {
    list.innerHTML = "";
    suggestions.forEach((suggestion, index) => {
      const item = document.createElement("li");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === active));
      item.className = index === active ? "active" : "";
      item.textContent = suggestion.label;
      // mousedown, not click: a click would blur the textarea first and lose the caret.
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        accept(suggestion);
      });
      list.appendChild(item);
    });
    list.hidden = suggestions.length === 0;
  };
  const refresh = (): void => {
    if (textarea.disabled) {
      return;
    }
    const match = findTrigger(textarea.value, textarea.selectionStart);
    suggestions = match ? suggest(match, getSources()) : [];
    active = 0;
    render();
  };

  textarea.addEventListener("input", refresh);
  textarea.addEventListener("click", refresh);
  textarea.addEventListener("blur", hide);
  textarea.addEventListener("keydown", (event) => {
    if (list.hidden || suggestions.length === 0) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active =
        (active + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
      render();
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(suggestions[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hide();
    }
  });
}

function makeTab(label: string, selected: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tab md-tab";
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", String(selected));
  button.textContent = label;
  return button;
}
