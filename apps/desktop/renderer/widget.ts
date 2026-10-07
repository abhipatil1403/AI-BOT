import { Widget, widgetCSS } from '../../../packages/ui/widget';
const style = document.createElement('style'); style.textContent = widgetCSS; document.head.append(style);
let requestId = 0;
const widget = new Widget(document.getElementById('widget')!, { copy: () => window.assistant.copyCode(requestId), resize: (width, height) => window.assistant.resizeWidget(width, height) });
window.assistant.onState(state => { requestId = state.requestId; widget.update(state); });
