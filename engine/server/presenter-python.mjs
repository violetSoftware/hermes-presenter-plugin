// Only explicit plugin caller transport is supported. Never discover legacy helpers.
export const presenterPython = 'python3';
export const presenterPythonArgs = () => { throw Error('Use the plugin-provided caller transport and credentials'); };
