export class EventEmitter {
  constructor() {
    this.events = {};
  }

  addEventListener(event, listener, options = {}) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    
    const wrappedListener = {
      callback: listener,
      once: options.once || false
    };
    
    this.events[event].push(wrappedListener);
  }

  removeEventListener(event, listener) {
    if (!this.events[event]) return;
    
    this.events[event] = this.events[event].filter(
      wrappedListener => wrappedListener.callback !== listener
    );
  }

  dispatchEvent(event) {
    const eventName = event.type;
    if (!this.events[eventName]) return;
    
    this.events[eventName] = this.events[eventName].filter(wrappedListener => {
      wrappedListener.callback.call(this, event);
      return !wrappedListener.once;
    });
  }

  emit(eventName, data) {
    const event = new CustomEvent(eventName, { detail: data });
    this.dispatchEvent(event);
  }
}

export class CustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.bubbles = options.bubbles || false;
    this.cancelable = options.cancelable || false;
  }

  preventDefault() {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }
}