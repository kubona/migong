(() => {
  const storageKey = "mwi-labyrinth-theme";
  const root = document.documentElement;

  function savedTheme() {
    try {
      const value = localStorage.getItem(storageKey);
      return value === "light" || value === "dark" ? value : null;
    } catch {
      return null;
    }
  }

  function systemTheme() {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  function render(theme) {
    root.dataset.theme = theme;
    const button = document.getElementById("theme-toggle");
    if (!button) return;
    const nextTheme = theme === "dark" ? "light" : "dark";
    const nextLabel = nextTheme === "light" ? "明亮" : "暗色";
    button.innerHTML = `<span aria-hidden="true">${nextTheme === "light" ? "☀" : "☾"}</span><span>${nextLabel}</span>`;
    button.setAttribute("aria-label", `切换为${nextLabel}主题`);
    button.title = `切换为${nextLabel}主题`;
  }

  function setTheme(theme) {
    render(theme);
    try { localStorage.setItem(storageKey, theme); } catch { /* 本地存储不可用时仍允许本次切换 */ }
  }

  render(savedTheme() || systemTheme());
  document.addEventListener("DOMContentLoaded", () => {
    render(root.dataset.theme);
    document.getElementById("theme-toggle")?.addEventListener("click", () => {
      setTheme(root.dataset.theme === "dark" ? "light" : "dark");
    });
  }, { once: true });
})();
