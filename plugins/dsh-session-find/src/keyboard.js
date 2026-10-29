const findKeyboardInstalls = new WeakMap();
const findKeyboardHidden = '[hidden], [inert], [aria-hidden="true"]';
const findKeyboardOverlays = 'dialog[open], [role="dialog"], [aria-modal="true"], [data-shortcut-modal], [role="menu"], [role="listbox"], [popover]';
const findKeyboardNative = [
  '.xterm', '.monaco-editor', '.cm-editor', '.CodeMirror', '.ace_editor',
  'iframe', 'webview', 'object', 'embed', 'dialog', '[role="dialog"]', '[aria-modal="true"]',
  '[role="menu"]', '[role="menuitem"]', '[role="listbox"]', '[role="option"]',
  '[data-shortcut-modal]', '[data-code-editor]', '[data-code-preview]', '[data-document-preview]',
  '[data-textpreview-state]', '[data-textpreview-body]', '[data-document-loading]',
  '[data-html-preview]', '[data-pdf-preview]', '[data-image-preview]', '[data-document-markdown]',
  '[data-sidebar-browser-frame]', '[data-session-find-native]',
].join(', ');
const findKeyboardEditable = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [data-lexical-editor]';
const findKeyboardPanel = '[data-session-find-panel], .dsh-find';
const findKeyboardConversation = '[data-conversation-content][data-conversation-session]';

function keyboardElement(node) {
  return node?.nodeType === 1 && typeof node.matches === 'function';
}

function keyboardAncestors(element) {
  const result = [];
  while (keyboardElement(element)) {
    result.push(element);
    element = element.parentElement ?? element.getRootNode?.().host;
  }
  return result;
}

function keyboardVisible(element, window) {
  if (!keyboardElement(element) || element.isConnected === false) return false;
  for (const ancestor of keyboardAncestors(element)) {
    if (ancestor.matches(findKeyboardHidden)) return false;
    const style = window.getComputedStyle?.(ancestor);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
  }
  return typeof element.getClientRects === 'function' && [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
}

function keyboardOverlayOpen(document, window) {
  for (const element of document.querySelectorAll(findKeyboardOverlays)) {
    if (element.hasAttribute('popover')) {
      let open = element.getAttribute('data-state') === 'open';
      try { open ||= element.matches(':popover-open'); } catch {}
      if (!open) continue;
    }
    if (keyboardVisible(element, window)) return true;
  }
  return false;
}

function keyboardOwner(element, sessionId, document, window) {
  const chain = keyboardAncestors(element);
  if (chain.some(node => node.matches(findKeyboardNative) || node.matches(findKeyboardHidden))) return false;
  const panel = chain.find(node => node.matches(findKeyboardPanel));
  if (panel) {
    const explicit = panel.getAttribute('data-session-find-session');
    const sidebar = chain.find(node => node.hasAttribute('data-sidebar-right-session'));
    const sidebarOwner = sidebar?.getAttribute('data-sidebar-right-session');
    const owner = explicit ?? sidebarOwner;
    return owner === sessionId && (sidebarOwner === undefined || sidebarOwner === sessionId) && keyboardVisible(panel, window);
  }
  if (chain.some(node => node.matches('[data-sidebar-right-session], [data-dockkit-pane], [data-dockkit-float]'))) return false;
  const roots = [...document.querySelectorAll(findKeyboardConversation)].filter(root =>
    root.getAttribute('data-conversation-session') === sessionId && keyboardVisible(root, window) &&
    !keyboardAncestors(root).some(node => node.matches('[data-sidebar-right-session], [data-dockkit-pane], [data-dockkit-float]')));
  if (roots.length !== 1) return false;
  const root = roots[0];
  const occurrence = chain.find(node => node.hasAttribute('data-conversation-session'));
  if (occurrence && occurrence !== root) return false;
  const composer = chain.find(node => node.matches('[data-composer-seat], [data-composer-input]'));
  if (chain.some(node => node.matches(findKeyboardEditable)) && !composer) return false;
  if (composer) return chain.includes(root) && keyboardVisible(composer, window);
  const flow = chain.find(node => node.hasAttribute('data-chat-flow'));
  if (flow) return chain.includes(root) && keyboardVisible(flow, window);
  const blank = element === root || element.parentElement === root && element.hasAttribute('data-conversation-scroll') || element === document.body || element === document.documentElement;
  return blank && [...root.querySelectorAll('[data-chat-flow]')].some(flow =>
    keyboardVisible(flow, window) && keyboardAncestors(flow).find(node => node.hasAttribute('data-conversation-session')) === root);
}

function keyboardInputElements(event, document) {
  let path = [];
  try { path = event.composedPath?.() ?? []; } catch {}
  const target = path.find(keyboardElement) ?? (keyboardElement(event.target) ? event.target : event.target?.parentElement);
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return { target, active, path: path.filter(keyboardElement) };
}

export function canFindFromFocus({ window, document = window?.document, sessionId }) {
  if (!window || !document || typeof sessionId !== 'string' || !sessionId || document.visibilityState === 'hidden' || document.hasFocus?.() === false) return false;
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return keyboardElement(active) && keyboardVisible(active, window) && !keyboardOverlayOpen(document, window) && keyboardOwner(active, sessionId, document, window);
}

export function installFindKeyboard({ window, document = window?.document, getSessionId, open, isEnabled = () => true }) {
  if (!window?.addEventListener || !document?.addEventListener || typeof getSessionId !== 'function' || typeof open !== 'function' || typeof isEnabled !== 'function') {
    throw new TypeError('Find keyboard requires a window, document and synchronous callbacks.');
  }
  findKeyboardInstalls.get(window)?.();
  let disposed = false;
  let composing = false;
  let heldSession;
  const reset = () => { heldSession = undefined; };
  const compositionStart = () => { composing = true; reset(); };
  const compositionEnd = () => { composing = false; reset(); };
  const blur = () => { composing = false; reset(); };
  const keyup = event => {
    if (event.code === 'KeyF' || event.key?.toLowerCase() === 'f' || ['Control', 'Meta'].includes(event.key)) reset();
  };
  const consume = event => { event.preventDefault(); event.stopPropagation(); };
  const keydown = event => {
    if (disposed || event.defaultPrevented || event.cancelable === false || composing || event.isComposing || event.keyCode === 229 || event.which === 229 || document.visibilityState === 'hidden' || document.hasFocus?.() === false) return;
    if (event.altKey || event.shiftKey || Boolean(event.ctrlKey) === Boolean(event.metaKey) || event.getModifierState?.('AltGraph')) return;
    if (event.key?.toLowerCase() !== 'f' && !(event.code === 'KeyF' && (!event.key || event.key === 'Unidentified'))) return;
    let sessionId;
    try {
      if (!isEnabled()) return;
      sessionId = getSessionId();
    } catch { return; }
    if (typeof sessionId !== 'string' || !sessionId) return;
    const { target, active, path } = keyboardInputElements(event, document);
    if (!keyboardElement(target) || !keyboardVisible(target, window) || keyboardOverlayOpen(document, window)) return;
    if (path.some(element => keyboardAncestors(element).some(node => node.matches(findKeyboardNative)))) return;
    if (!keyboardOwner(target, sessionId, document, window)) return;
    if (active && active !== document.body && active !== document.documentElement && !keyboardOwner(active, sessionId, document, window)) return;
    if (event.repeat) {
      if (heldSession === sessionId) consume(event);
      return;
    }
    try { if (open(sessionId, event) === false) return; } catch { return; }
    heldSession = sessionId;
    consume(event);
  };
  document.addEventListener('keydown', keydown);
  document.addEventListener('compositionstart', compositionStart, true);
  document.addEventListener('compositionend', compositionEnd, true);
  window.addEventListener('keyup', keyup, true);
  window.addEventListener('blur', blur);
  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    document.removeEventListener('keydown', keydown);
    document.removeEventListener('compositionstart', compositionStart, true);
    document.removeEventListener('compositionend', compositionEnd, true);
    window.removeEventListener('keyup', keyup, true);
    window.removeEventListener('blur', blur);
    if (findKeyboardInstalls.get(window) === dispose) findKeyboardInstalls.delete(window);
  }
  findKeyboardInstalls.set(window, dispose);
  return dispose;
}
