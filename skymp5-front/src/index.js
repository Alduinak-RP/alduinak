import React from 'react';
import ReactDOM from 'react-dom';

import App from './App';

import { store } from './redux/store';
import { Provider } from 'react-redux';

import { Widgets } from './utils/Widgets';

import './main.scss';

if (!window.skyrimPlatform) {
  window.skyrimPlatform = {};
  window.needToScroll = true;
}

if (!window.skyrimPlatform.widgets) {
  window.skyrimPlatform.widgets = new Widgets([]);
}

ReactDOM.render(
  <React.StrictMode>
    <Provider store={store}>
      <App elem={window.skyrimPlatform.widgets.get()} />
    </Provider>
  </React.StrictMode>,
  document.getElementById('root')
);

// Called from skymp5-functions-lib, chatProperty.ts
window.scrollToLastMessage = () => {
  const _list = document.querySelector('#chat .chat-list');
  if (_list != null && window.needToScroll) { _list.scrollTop = _list.scrollHeight; }
};

window.playSound = (name) => {
  (new Audio(require('./sound/' + name).default)).play();
};

if (window.skyrimPlatform?.sendMessage) {
  window.skyrimPlatform.sendMessage('front-loaded');
}

// Escape inside the browser closes any open RP menu on the first press.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    try { window.skyrimPlatform.sendMessage("menu:escape"); } catch (err) { /* outside game */ }
  }
});
