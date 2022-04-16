import { default as Manager } from './manager.js';

export default class ModuleManager extends Manager {
  constructor(
    moduleFactory,
    componentElement, canvasElement, consoleElement,
    userOptions
  ) {
    super(
      componentElement, canvasElement, consoleElement,
      userOptions
    );

    this._moduleFactory = moduleFactory;
  }

////////////////////////////////////////////////////////////////////////
// PUBLIC PROPERTIES
////////////////////////////////////////////////////////////////////////

  static async initialize(
    moduleFactory,
    componentElement, canvasElement, consoleElement,
    userOptions
  ) {
    const manager = new ModuleManager(
      moduleFactory,
      componentElement, canvasElement, consoleElement,
      userOptions
    );

    await manager._initializeModule();

    return manager;
  }

  async callMain(args) {
    this._moduleInstance.callMain(args);
  }

  async abort(what = 'Aborted by JS component.') {
    try {
      this._moduleInstance.abort(what);
    } catch(e) {
      // This API assumes intentional aborting, so fail silently.
    }
  }

  async pauseMainLoop() {
    this._moduleInstance.pauseMainLoop();
  }

  async resumeMainLoop() {
    this._moduleInstance.resumeMainLoop();
  }

  async requestFullscreen() {
    return await this.__canvasElement.requestFullscreen();
  }

  async exitFullscreen() {
    return await this.__canvasElement.exitFullscreen();
  }

  onResizeCanvas(...args) {
    if (this.__options.resizeCanvasOnElementSizing) {
      this._handleResizeCanvas(...args);
    }
  }

////////////////////////////////////////////////////////////////////////
// INITIALIZATION MEHTODS
////////////////////////////////////////////////////////////////////////

  async _initializeModule() {
    this._moduleInstance = await this._moduleFactory({
      // Pass to Emscripten any user-specified WASM path.
      // Load this first so the user can override with their own function.
      locateFile: this.__getLocateFile(),

      // Allow user to instantiate Module with their own properties
      ...this.__initialModule,

      // Don't run main() immediately so that we can patch Module with
      // scoped behavior.
      noInitialRun: true,

      // Specify keyboard element used by emscripten/src/library_sdl.js
      keyboardListeningElement:
        this.__options.captureFocusOnComponent ? this.__componentElement : undefined,

      // Specify canvas used by some aspects of Module. Other aspects retrieve
      // the canvas by querying specialHTMLTargets -- see patchModule().
      canvas:
        this.__options.redirectCanvasRequests ? this.__canvasElement : undefined,

      // Perform extra cleanup upon component dismounting
      onAbort: this._getAbortHandler(),

      // Other handlers
      print: this.__getPrintHandler(),
      printErr: this.__getPrintErrHandler()
    });

    this._patchModule();
  }

////////////////////////////////////////////////////////////////////////
// SCOPE PATCHING
////////////////////////////////////////////////////////////////////////

  _patchModule() {
    this._patchCanvasQueries();
    this._attachFocusInvokers();
    this._patchGlViewport();
    this._patchEventHandlers();
  }

  _patchCanvasQueries() {
    if (!this.__options.redirectCanvasRequests)
      return;

    // Point all of Module's requests for the canvas element to our component
    if (this.__canvasElement instanceof HTMLElement)
      this._moduleInstance.specialHTMLTargets['#canvas'] = this.__canvasElement;
  }

  _attachFocusInvokers() {
    if (!this.__options.captureFocusOnComponent)
      return;

    // Invoke keyboard focus on our component by attaching
    // a capture handler so that it runs before emscripten's
    let componentElement = this.__componentElement;
    let handler = function() {
      componentElement.focus();
    };

    if (this.__canvasElement instanceof HTMLElement) {
      this.__canvasElement.addEventListener('mousedown', handler, true);
      this.__canvasElement.addEventListener('touchstart', handler, true);
    }

    // To respect a11y, don't redirect focus from a textarea
    // if (__consoleElement instanceof HTMLElement)
    //   __consoleElement.addEventListener('focus', handler, true);
  }

////////////////////////////////////////////////////////////////////////
// EVENT HANDLER PATCHES
////////////////////////////////////////////////////////////////////////

  _patchEventHandlers() {
    // Patch global events so they can be scoped to our component.
    // We do this via patching JSEvents.registerOrRemoveHandler.

    const patchKeyEventHandler = this._patchKeyEventHandler.bind(this);
    const patchResizeEventHandler = this._patchResizeEventHandler.bind(this);
    const patchFullscreenchangedEventHandler = this._patchFullscreenchangedEventHandler.bind(this);

    this._moduleInstance.JSEvents.registerOrRemoveHandler = function (predefinedFunction) {
      return function(eventHandler) {
        // These functions mutate eventHandler before passing it to JSEvents.registerOrRemoveHandler.
        // They return `true` when the patch function encounters its corresponding event type..
        patchKeyEventHandler(eventHandler)
          || patchResizeEventHandler(eventHandler)
          || patchFullscreenchangedEventHandler(eventHandler);

        predefinedFunction(eventHandler);
      }
    }(this._moduleInstance.JSEvents.registerOrRemoveHandler);
  }

////////////////////////////////////////////////////////////////////////
// KEYBOARD EVENTS
////////////////////////////////////////////////////////////////////////

  _patchKeyEventHandler(eventHandler) {
    if (eventHandler.target !== window
        || !eventHandler.eventTypeString.startsWith('key'))
      return false;

    // Capture keyboard focus to component instead of listening globally.
    if (this.__options.captureFocusOnComponent)
      eventHandler.target = this.__componentElement;

    // To respect a11y, only handle the TAB key when requested. We default
    // to ignore the TAB key when not handling events globally.
    if (!this.__options.captureTabKey) {
      eventHandler.handlerFunc = function(predefinedHandlerFunc) {
        return function(evt) {
          if (evt.keyCode !== 9)
            predefinedHandlerFunc(evt);
        }
      }(eventHandler.handlerFunc);
    }

    // Signal that we operated on this eventHandler
    return true;
  }

////////////////////////////////////////////////////////////////////////
// CANVAS RESIZE EVENTS
////////////////////////////////////////////////////////////////////////

  _handleResizeCanvas(resizeEntry) {
    // This is half of the patch to Emscripten's window.onresize handler.
    // This is called by a ResizeObserve that is attached to our canvas.
    // We use this to respond to our canvas's element resize specifically,
    // rather than the entire window.

    const event = new FocusEvent('resize', {
      'relatedTarget': resizeEntry.target
    });
    window.dispatchEvent(event);
  }

  _patchResizeEventHandler(eventHandler) {
    // This is the second half of the patch to window.onresize handler.
    //
    // By default, Emscripten listens for canvas size changes by attaching
    // to the 'resize' event on `window`. Without patches, all
    // Modules will react to the same window resize event.
    //
    // We patch Emscripten's window.onresize listener to only react when
    // handleResizeCanvas() signals that our canvas was resized.
    //
    // It would be nice to get rid of the window.onresize listener entirely
    // and only call resize logic from handleResizeCanvas(), but we can't
    // hand over Emscripten's `userData` in `__registerUiEventCallback()`
    // without this handler.

    if (eventHandler.target !== window
        || eventHandler.eventTypeString !== 'resize')
      return false;

    const options = this.__options;
    const canvasElement = this.__canvasElement;
    const fixCanvasSizing = this._fixCanvasSizing.bind(this);
    const fixCanvasViewport = this._fixCanvasViewport.bind(this);

    eventHandler.handlerFunc = function(predefinedHandlerFunc) {
      return function(evt) {
        if (options.resizeCanvasOnElementSizing) {
          // Only change canvas content dimensions when our component's canvas is resized
          if (evt.relatedTarget === canvasElement)
            // It's safe to pass our custom event because Emscripten does not use the event in 
            // resizeHandlerFunc because it pulls size dimensions from other variables.
            predefinedHandlerFunc(evt);
        }
        // If resizeCanvasOnElementSizing is disabled, revert to default behavior
        else
          predefinedHandlerFunc(evt);

        // Also fix canvas sizing if entering fullscreen
        if (options.resizeCanvasOnFullscreenChange
            && document.fullscreenElement === canvasElement) {
          fixCanvasSizing();
          fixCanvasViewport();
        }
        // If resizeCanvasOnFullscreenChange is disabled, we still want
        // to fix the viewport if resizeCanvasOnElementSizing is enabled
        else if (options.resizeCanvasOnElementSizing)
          fixCanvasViewport();
      }
    }(eventHandler.handlerFunc);

    // Signal that we handled this eventHandler
    return true;
  }

  _patchFullscreenchangedEventHandler(eventHandler) {
    // Here, we catch fullscreen exits and fix the content size of the
    // canvas element. Fullscreen enters are handled by patchResizeEventHandler().

    if (!this.__options.resizeCanvasOnFullscreenChange)
      return;

    if (eventHandler.target !== document
        || !eventHandler.eventTypeString.endsWith('fullscreenchange'))
      return false;

    const canvasElement = this.__canvasElement;
    const fixCanvasSizing = this._fixCanvasSizing.bind(this);
    const fixCanvasViewport = this._fixCanvasViewport.bind(this);

    eventHandler.handlerFunc = function(predefinedHandlerFunc) {
      return function(evt) {
        predefinedHandlerFunc(evt);
        
        const canvasWasFullscreen =
          (!document.fullscreenElement
            && (evt.target === canvasElement 
                || evt.srcElement === canvasElement)
          );

        if (canvasWasFullscreen) {
          fixCanvasSizing();
          fixCanvasViewport();
        }
      }
    }(eventHandler.handlerFunc);

    // Signal that we handled this eventHandler
    return true;
  }

  _patchGlViewport() {
    // We patch glViewport() to resolve cases where it is called without
    // adjusting for window.devicePixelRatio. We do so via patching
    // Module.GL.createContext() so that all created contexts can have the
    // patched behavior.

    if (!this.__options.adjustViewportByDevicePixelRatio)
      return;

    const GL = this._moduleInstance.GL;

    if (!GL)
      return;

    let patchedCreateContext = function (predefinedCreateContext) {
      return function(...args) {
        let handle = predefinedCreateContext.apply(GL, args);

        if (!handle)
          return handle;
        
        let gl = GL.getContext(handle).GLctx;

        if (!gl)
          return handle;

        let patchedViewport = function(predefinedViewport) {
          return function(x0, y0, w0, h0) {
            const dpr = window.devicePixelRatio;
            if (dpr !== 1) {
              const w = Math.floor(w0 * dpr);
              const h = Math.floor(h0 * dpr);
              const roundingError = 1;
              if (
                (w >= gl.canvas.width && w <= roundingError + gl.canvas.width)
                && (h >= gl.canvas.height && h <= roundingError + gl.canvas.height)
              ) {
                w0 = gl.canvas.width;
                h0 = gl.canvas.height;
              }
            }
            predefinedViewport.call(gl, x0, y0, w0, h0);
          }
        }(gl.viewport);
        gl.viewport = patchedViewport;

        return handle;
      }
    }(GL.createContext);
    GL.createContext = patchedCreateContext;
  }

  _fixCanvasSizing() {
    // set our canvas content size manually because
    // emscripten-ports/SDL2/src/video/emscripten/SDL_emscriptenevents.c
    // Emscripten_HandleResize() does not update the content size
    // when in fullscreen.

    const rect = this.__canvasElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio;

    this.__canvasElement.width = rect.width * dpr;
    this.__canvasElement.height = rect.height * dpr;
  }

  _fixCanvasViewport() {
    // Fix the GL viewport
    const gl = this.__canvasElement.getContext('webgl');

    if (gl)
      gl.viewport(0, 0, this.__canvasElement.width, this.__canvasElement.height);
  }

////////////////////////////////////////////////////////////////////////
// ABORT HANDLER
////////////////////////////////////////////////////////////////////////

  _getAbortHandler() {
    // In this scope, `this` refers to our class
    const disposeGlContexts = this.__disposeGlContexts.bind(this);
    const options = this.__options;
    const initialModule = this.__initialModule;

    return function(what) {
      // In this scope, `this` refers to the Module object in which this handler lives
      let module = this;

      if (options.disposeCanvasOnAbort)
        disposeGlContexts(module);

      // If user supplied their own function in `__initialModule`
      if (initialModule.onAbort instanceof Function)
        initialModule.onAbort(what);
    };
  }
}
