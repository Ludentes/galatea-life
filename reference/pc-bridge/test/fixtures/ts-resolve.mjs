// Lets Node run the package's TypeScript sources as they are (`--experimental-transform-types`): an
// import of `./x.js` that has no such file resolves to `./x.ts`, as TypeScript's own resolution does.
import { register } from "node:module";

register("data:text/javascript," + encodeURIComponent(`
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".js") && (specifier.startsWith(".") || specifier.startsWith("/")) && context.parentURL) {
    const url = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(url))) {
      const ts = new URL(url.href.slice(0, -3) + ".ts");
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
  }
  return next(specifier, context);
}
`));
