// emscripten-component-base - component.js
//
// Common code for reusable components that use Emscripten modules.
//
// Some patching is required for an Emscripten module to be encapsulated
// to our component. By default, Emscripten makes use of window globals,
// notably a <canvas id="canvas">. It also listens to keyboard events
// on the window object. These are bad assumptions for reusable
// components, so we re-scope these behaviors to our component.
//
// We assume that you compiled your WASM to output filetype *.js and
// that you compiled your WASM with these linker flags:
//
//     -s MODULARIZE=1 -s ENVIRONMENT='web'
//
//     -s EXTRA_EXPORTED_RUNTIME_METHODS="['specialHTMLTargets',
//            'JSEvents', 'GL', 'callMain', 'abort']"
//
// MODULARIZE prevents the Emscripten module from polluting the window
// object. ENVIRONMENT optimizes the code size to output routines
// for browsers only.
//
// EXTRA_EXPORTED_RUNTIME_METHODS exposes Module internals so that we
// may patch them.

export default class Manager {
  constructor(
    componentElement, canvasElement, consoleElement,
    userOptions
  ) {
    this.__componentElement = componentElement;
    this.__canvasElement = canvasElement;
    this.__consoleElement = consoleElement;

    this.__initialModule = userOptions.initialModule || {};
    this.__wasmPath = userOptions.wasmPath;

    this.__setOptions(userOptions);
  }

////////////////////////////////////////////////////////////////////////
// OPTIONS
////////////////////////////////////////////////////////////////////////

  __setOptions(userOptions) {
    this.__options = {
      ...this.__getDefaultOptionsForVersion(userOptions),
      ...userOptions
    };
  }

  __getDefaultOptionsForVersion(userOptions) {
    const defaultOptions = {
      // Redirect all of Module's queries for <canvas> to our component's
      // canvas, instead of <canvas id="canvas">.
      redirectCanvasRequests: true,
  
      // Capture keyboard focus to component instead of listening globally.
      captureFocusOnComponent: true,
  
      // Capture TAB key. Defaults to false to respect a11y.
      captureTabKey: false,
  
      // Change canvas content dimensions when our component's canvas is resized,
      // not just when the window is resized.
      resizeCanvasOnElementSizing: true,
  
      // Force canvas content resize upon requesting fullscreen. Normally,
      // the SDL implementation does not do this.
      // If you use EmscriptenFullscreenStrategy, you should set this false.
      resizeCanvasOnFullscreenChange: true,
  
      // Adjust width and height inputs to gl.viewport() by window.devicePixelRatio.
      // If you use EmscriptenFullscreenStrategy, you should set this false.
      adjustViewportByDevicePixelRatio: true,
  
      // Dispose canvas when calling abort().
      disposeCanvasOnAbort: true
    }

    if (!userOptions.emsdkVersion)
      return defaultOptions;
    
    // TODO: toggle patches depending on user-specified EMSDK version.
    // Ideally, we would compare version numbers (e.g., by npm semver)
    // rather than switch-case. For now, just return defaults.
    
    switch(userOptions.emsdkVersion) {
      default:
        return defaultOptions;
    }
  }

////////////////////////////////////////////////////////////////////////
// PUBLIC PROPERTIES
////////////////////////////////////////////////////////////////////////

  static async initialize() {
    throw new Error('Manager::initialize() not implemented by the subclass.');
  }

  callMain() {
    throw new Error('Manager::callMain() not implemented by the subclass.');
  }

  abort() {
    throw new Error('Manager::abort() not implemented by the subclass.');
  }

  pauseMainLoop() {
    throw new Error('Manager::pauseMainLoop() not implemented by the subclass.');
  }

  resumeMainLoop() {
    throw new Error('Manager::resumeMainLoop() not implemented by the subclass.');
  }

  async requestFullscreen() {
    throw new Error('Manager::requestFullscreen() not implemented by the subclass.');
  }

  async exitFullscreen() {
    throw new Error('Manager::exitFullscreen() not implemented by the subclass.');
  }

  onResizeCanvas() {
    throw new Error('Manager::onResizeCanvas() not implemented by the subclass.');
  }

////////////////////////////////////////////////////////////////////////
// INITIALIZATION MEHTODS
////////////////////////////////////////////////////////////////////////

  async _initializeModule() {
    throw new Error('Manager::_initializeModule() not implemented by the subclass.')
  }

  __getLocateFile() {
    const wasmPath = this.__wasmPath;
    const isAbsoluteUrl = this.__isAbsoluteUrl.bind(this);
    return function(path, scriptDirectory) {
      if (!wasmPath)
        return scriptDirectory + path;
      
      if (!isAbsoluteUrl(wasmPath))
        return scriptDirectory + wasmPath;
      else
        return wasmPath;
    }
  }

  __isAbsoluteUrl(url) {
    try {
      new URL(url);
      return true;
    } catch (e) {
      // URL() throws an exception when passed a relative path and
      // no second argument (`base`)
      return false;
    }
  }

////////////////////////////////////////////////////////////////////////
// SCOPE PATCHING
////////////////////////////////////////////////////////////////////////

  _patchModule() {
    throw new Error('Manager::_patchModule() not implemented by subclass.');
  }

////////////////////////////////////////////////////////////////////////
// ABORT HANDLER
////////////////////////////////////////////////////////////////////////

  __disposeGlContexts(module) {
    // Dispose any WebGL contexts.
    //
    // Caveat: There is no `ctx.destroyContext()` API and emscripten just sets
    // context references to `null` for VM to garbage collect. Depending on
    // browser implementation, the GL context gets disposed upon GC.
    //
    // To control this directly, attempt to do this ourselves via the "WEBGL_lose_context" extension.
    //
    // See https://github.com/mapbox/mapbox-gl-js/issues/2656
    // See https://www.khronos.org/webgl/public-mailing-list/public_webgl/1611/msg00012.php

    if (!module.GL)
      return;

    Object.keys(module.GL.contexts).forEach(function(key) {
      try {
        const extension = module.GL.contexts[key].GLctx.getExtension('WEBGL_lose_context');
        if (extension)
          extension.loseContext();
        module.GL.deleteContext(key);
      } catch(e) {
        // Fail silently; GL.contexts[key] is likely null and GL.deleteContext()
        // does not handle this correctly as of emscripten 2.0.11.
      }
    });
  }

////////////////////////////////////////////////////////////////////////
// OTHER HANDLERS
////////////////////////////////////////////////////////////////////////

  // From emscripten/src/shell.html
  __getPrintHandler() {
    const predefinedPrint = this.__initialModule.print instanceof Function ? this.__initialModule.print.bind(this) : null;
    var element = this.__consoleElement;
    if (element) element.value = ''; // clear browser cache
    return function(text) {
      if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
      // These replacements are necessary if you render to raw HTML
      //text = text.replace(/&/g, "&amp;");
      //text = text.replace(/</g, "&lt;");
      //text = text.replace(/>/g, "&gt;");
      //text = text.replace('\n', '<br>', 'g');
      console.log(text);
      if (element) {
        element.value += text + "\n";
        element.scrollTop = element.scrollHeight; // focus on bottom
      }

      // If user supplied their own function
      if (predefinedPrint instanceof Function)
        predefinedPrint(text);
    };
  }

  // From emscripten/src/shell.html
  __getPrintErrHandler() {
    const predefinedPrintErr = this.__initialModule.printErr instanceof Function ? this.__initialModule.printErr.bind(this) : null;
    return function(text) {
      if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
        console.error(text);

      // If user supplied their own function
      if (predefinedPrintErr instanceof Function)
        predefinedPrintErr(text);
    }
  }
}
