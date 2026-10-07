import { Widget, widgetCSS } from '../../../packages/ui/widget';
const style = document.createElement('style'); style.textContent = widgetCSS; document.head.append(style);
let requestId = 0;
const widget = new Widget(document.getElementById('widget')!, { copy: () => window.assistant.copyCode(requestId), dismiss: id => window.assistant.dismissAnswer(id), resize: (width, height, visible) => window.assistant.resizeWidget(width, height, visible) });
window.assistant.onState(state => { requestId = state.requestId; widget.update(state); });
