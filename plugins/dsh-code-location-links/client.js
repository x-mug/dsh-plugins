window.__ModuleLoader__.load({
  id: '@x-mug/dsh-code-location-links',
  factory: () => {
    const prefix = 'dsh-resource://file/session/';
    const hasFilename = (name) => /\.[a-zA-Z0-9_+-]+$/.test(name) || /^(?:README|LICENSE|LICENCE|NOTICE|Dockerfile|Containerfile|Makefile|Gemfile|Rakefile)$/i.test(name);
    const positiveInteger = (text) => /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
    const encodeSegment = (value) => encodeURIComponent(value).replace(/%3A/gi, ':');

    function normalizeFileLocation(address, options) {
      if (typeof address !== 'string' || !address.startsWith(prefix)) return undefined;
      const pathStart = address.indexOf('/', prefix.length);
      if (pathStart <= prefix.length) return undefined;
      const suffixStart = address.search(/[?#]/);
      const end = suffixStart < 0 ? address.length : suffixStart;
      if (end <= pathStart + 1) return undefined;
      const encodedPath = address.slice(pathStart + 1, end);
      const encodedSegments = encodedPath.split('/');
      let segments;
      try {
        const sessionId = decodeURIComponent(address.slice(prefix.length, pathStart));
        if (!sessionId || /[/\\\u0000-\u001f\u007f]/.test(sessionId)) return undefined;
        segments = encodedSegments.map(decodeURIComponent);
      } catch {
        return undefined;
      }
      if (segments.some((segment) => /[/\u0000-\u001f\u007f]/.test(segment))) return undefined;
      const decodedPath = segments.join('/');
      let path = decodedPath;
      if (/^(?:file|https?|mailto|javascript|data|vscode):/i.test(path)) return undefined;
      if (/^\/?[a-z]:[/\\]/i.test(path) || path.startsWith('\\\\')) {
        path = path.replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1');
      }
      const slash = path.lastIndexOf('/');
      const filename = path.slice(slash + 1);
      let line;
      let location = /^(.*?):([1-9]\d*)(?::([1-9]\d*))?$/.exec(filename);
      if (!location) location = /^(.*)\(([1-9]\d*)(?:,\s*([1-9]\d*))?\)$/.exec(filename);
      if (location && hasFilename(location[1]) && !location[1].includes('\\')) {
        const parsedLine = positiveInteger(location[2]);
        const column = location[3] === undefined ? undefined : positiveInteger(location[3]);
        if (parsedLine !== undefined && (location[3] === undefined || column !== undefined)) {
          line = parsedLine;
          path = path.slice(0, slash + 1) + location[1];
        }
      }
      const suffix = address.slice(end);
      const fragment = /#L([1-9]\d*)(?:C([1-9]\d*))?(?:-L([1-9]\d*)(?:C([1-9]\d*))?)?$/.exec(suffix);
      if (line === undefined && fragment && hasFilename(path.slice(path.lastIndexOf('/') + 1)) && fragment.slice(1).filter((part) => part !== undefined).every((part) => positiveInteger(part) !== undefined) && (fragment[3] === undefined || Number(fragment[3]) >= Number(fragment[1]))) {
        line = positiveInteger(fragment[1]);
      }
      if (path === decodedPath && line === undefined) return undefined;
      const params = options?.params;
      if (line !== undefined && params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) return undefined;
      const normalizedAddress = path === decodedPath
        ? address.slice(0, end) + suffix
        : address.slice(0, pathStart + 1) + path.split('/').map(encodeSegment).join('/') + suffix;
      return {
        address: normalizedAddress,
        options: line === undefined ? options : {
          ...options,
          params: { ...params, line: params?.line ?? line }
        }
      };
    }

    function apply(ctx) {
      let active = true;
      ctx.effect(() => () => { active = false; });
      ctx.on('internal/get', (_caller, name, _error, next) => {
        const service = next();
        if (name !== 'sidebarRight' || service === undefined || service === null) return service;
        return new Proxy(service, {
          get(target, property, receiver) {
            const original = Reflect.get(target, property, receiver);
            if (property !== 'openResource' || typeof original !== 'function') return original;
            return function (address, options, ...rest) {
              const location = active ? normalizeFileLocation(address, options) : undefined;
              return Reflect.apply(original, this === receiver ? target : this, location === undefined
                ? [address, options, ...rest]
                : [location.address, location.options, ...rest]);
            };
          }
        });
      });
    }

    return { apply, inject: ['sidebarRight'] };
  }
});
