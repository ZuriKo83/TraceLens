import {writeFile, rename} from 'node:fs/promises';

async function persist(path, content) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content, {mode: 0o600});
  await rename(temporary, path);
}

// Keep session-only cookies across browser restarts without rewriting an unchanged file.
export function createSessionSaver(context, path, {write = persist} = {}) {
  let saved;
  let pending;
  return function save() {
    if (pending) return pending;
    pending = (async () => {
      const cookies = (await context.cookies()).filter(cookie => cookie.expires === -1);
      const content = JSON.stringify(cookies);
      if (content === saved) return;
      await write(path, content);
      saved = content;
    })().finally(() => { pending = null; });
    return pending;
  };
}
