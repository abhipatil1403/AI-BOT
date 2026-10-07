import { Widget, widgetCSS } from '../../../packages/ui/widget';
const style = document.createElement('style'); style.textContent = widgetCSS; document.head.append(style);
const widget = new Widget(document.getElementById('widget')!, { copy: () => window.assistant.copyCode(), resize: (width, height) => window.assistant.resizeWidget(width, height) });
window.assistant.onState(state => widget.update(state));
