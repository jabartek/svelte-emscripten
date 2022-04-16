# emscripten-component-base

This is a shared module between components that use Emscripten.

Include this repository as a submodule in your git project. Then,
import in your component:

```js
import { ModuleManager } from './emscripten-component-base'

managerInstance = await ModuleManager.initialize(
  module,
  componentElement, canvasElement, consoleElement,
  userOptions
);
```

## License

MIT License, see LICENSE.
