// Окна <dialog> на старых телефонах (Safari до 15.4, старые WebView Android): там элемент
// неизвестен, и без замены окна студии просто не открылись бы. Замена простая: окно по центру
// поверх затемнения, Esc и «Назад» закрывают верхнее окно, форма method="dialog" закрывает своё.

export function installDialogFallback() {
  const probe = document.createElement("dialog");
  if (typeof probe.showModal === "function") return false;
  const proto = Object.getPrototypeOf(probe);
  const stack = [];
  const shade = document.createElement("div");
  shade.className = "dialog-shade-fallback";
  shade.hidden = true;

  const place = () => {
    stack.forEach((dialog, index) => { dialog.style.zIndex = String(1001 + index * 2); });
    const top = stack[stack.length - 1];
    if (!shade.isConnected) document.body.append(shade);
    shade.hidden = !top;
    if (top) shade.style.zIndex = String(Number(top.style.zIndex) - 1);
    document.documentElement.classList.toggle("has-dialog-fallback", Boolean(top));
  };

  Object.defineProperty(proto, "open", {
    configurable: true,
    get() { return this.hasAttribute("open"); },
    set(value) {
      if (value) this.setAttribute("open", "");
      else this.removeAttribute("open");
    },
  });
  proto.show = function show() {
    this.setAttribute("open", "");
  };
  proto.showModal = function showModal() {
    if (this.hasAttribute("open")) return;
    this.classList.add("dialog-fallback");
    this.setAttribute("open", "");
    stack.push(this);
    place();
  };
  proto.close = function close(value) {
    if (!this.hasAttribute("open")) return;
    if (value !== undefined) this.returnValue = String(value);
    this.removeAttribute("open");
    const index = stack.indexOf(this);
    if (index >= 0) stack.splice(index, 1);
    place();
    this.dispatchEvent(new Event("close"));
  };

  // Щелчок по затемнению — как щелчок по полю вокруг настоящего окна (окна сами решают, закрываться ли).
  shade.addEventListener("click", (event) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    top.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: -1, clientY: -1 }));
    event.stopPropagation();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !stack.length) return;
    const top = stack[stack.length - 1];
    if (top.dispatchEvent(new Event("cancel", { cancelable: true }))) top.close();
  });
  // <form method="dialog">: отправка закрывает окно, а не перезагружает страницу.
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || (form.getAttribute("method") || "").toLowerCase() !== "dialog") return;
    event.preventDefault();
    const dialog = form.closest("dialog");
    dialog?.close(event.submitter?.value);
  }, true);
  return true;
}
