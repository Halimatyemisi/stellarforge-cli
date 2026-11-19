import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ValidationCliError } from '../errors/errors.js';
import type {
  GenerationContext,
  ProjectGenerationPreview,
  ProjectGenerationPreviewFile,
  ProjectGenerationResult,
} from './types.js';

const SUBSTITUTION_TOKEN = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

export interface TemplateGenerationOptions {
  readonly templateRoot: string;
  readonly dryRun?: boolean;
}

/** Filename of the generated project provenance marker. */
export const GENERATED_MARKER_FILENAME = '.stellarforge.json';

/** Package identifier recorded in the generated provenance marker. */
export const GENERATOR_PACKAGE_NAME = '@diginodes/stellarforge-cli';

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);

  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function assertSafeEntryName(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new ValidationCliError('Template contains an unsafe file path.');
  }
}

function renderText(
  input: string,
  variables: Readonly<Record<string, string>>,
): { readonly content: string; readonly substitutions: readonly string[] } {
  const substitutions = new Set<string>();
  const content = input.replace(SUBSTITUTION_TOKEN, (_match, key: string) => {
    const value = variables[key];

    if (value === undefined) {
      throw new ValidationCliError(
        `Template contains unsupported substitution token '{{${key}}}'.`,
      );
    }

    substitutions.add(`{{${key}}} -> ${value}`);
    return value;
  });

  return { content, substitutions: [...substitutions] };
}

function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

function visitTemplateTree(
  templateRoot: string,
  relativeDirectory: string,
  variables: Readonly<Record<string, string>>,
  visitFile: (
    relativePath: string,
    content: Buffer | string,
    substitutions: readonly string[],
  ) => void,
  visitDirectory: (relativePath: string) => void,
): void {
  const sourceDirectory = resolve(templateRoot, relativeDirectory);
  const entries = readdirSync(sourceDirectory, { withFileTypes: true }).sort(
    (a, b) => {
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    },
  );

  for (const entry of entries) {
    assertSafeEntryName(entry.name);

    const relativePath = join(relativeDirectory, entry.name);
    const sourcePath = resolve(templateRoot, relativePath);

    if (!isWithin(templateRoot, sourcePath)) {
      throw new ValidationCliError(
        'Template file path escapes the trusted project root.',
      );
    }

    const sourceStat = lstatSync(sourcePath);

    if (sourceStat.isSymbolicLink()) {
      throw new ValidationCliError(
        'Template symbolic links are not supported.',
      );
    }

    if (sourceStat.isDirectory()) {
      visitDirectory(relativePath);
      visitTemplateTree(
        templateRoot,
        relativePath,
        variables,
        visitFile,
        visitDirectory,
      );
      continue;
    }

    if (!sourceStat.isFile()) {
      throw new ValidationCliError(
        'Template contains an unsupported filesystem entry.',
      );
    }

    const content = readFileSync(sourcePath);

    if (isBinary(content)) {
      visitFile(relativePath, content, []);
      continue;
    }

    const rendered = renderText(content.toString('utf8'), variables);
    visitFile(relativePath, rendered.content, rendered.substitutions);
  }
}

function assertDestinationContainment(root: string, destination: string): void {
  const destinationParent = dirname(destination);

  if (!isWithin(destinationParent, destination)) {
    throw new ValidationCliError(
      'Project destination escapes its validated parent directory.',
    );
  }

  if (existsSync(root)) {
    try {
      const realRoot = realpathSync(root);
      let existing = destination;
      while (!existsSync(existing)) {
        const parent = dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }

      if (existsSync(existing)) {
        const realExisting = realpathSync(existing);
        const rel = relative(realRoot, realExisting);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new ValidationCliError(
            'Project destination escapes its validated parent directory.',
          );
        }
      }
    } catch (error) {
      if (error instanceof ValidationCliError) throw error;
    }
  }

  let current = destination;
  while (current !== dirname(current)) {
    const parent = dirname(current);
    if (existsSync(current) && existsSync(parent)) {
      try {
        const realCurrent = realpathSync(current);
        const realParent = realpathSync(parent);
        const rel = relative(realParent, realCurrent);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new ValidationCliError(
            'Project destination escapes its validated parent directory.',
          );
        }
      } catch (error) {
        if (error instanceof ValidationCliError) throw error;
      }
    }
    current = parent;
  }
}

export function generateProjectFromTemplate(
  context: GenerationContext,
  options: TemplateGenerationOptions,
): ProjectGenerationResult | ProjectGenerationPreview {
  const templateRoot = resolve(options.templateRoot);
  const destination = resolve(context.destination.destination);
  const destinationParent = dirname(destination);
  const root = resolve(context.input.cwd);

  if (!existsSync(templateRoot) || !lstatSync(templateRoot).isDirectory()) {
    throw new ValidationCliError('Selected template source is unavailable.');
  }

  if (lstatSync(templateRoot).isSymbolicLink()) {
    throw new ValidationCliError(
      'Template source must not be a symbolic link.',
    );
  }

  assertDestinationContainment(root, destination);

  const destinationExisted = existsSync(destination);

  if (destinationExisted) {
    const destinationStat = lstatSync(destination);

    if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
      throw new ValidationCliError(
        'Project destination is not a safe empty directory.',
      );
    }

    if (readdirSync(destination).length > 0) {
      throw new ValidationCliError(
        'Project destination must be empty before generation.',
      );
    }
  }

  const realDestinationParentAtStart = existsSync(destinationParent)
    ? realpathSync(destinationParent)
    : undefined;

  const variables = {
    projectName: context.input.projectName,
    templateId: context.template.templateId,
  };

  if (options.dryRun) {
    const files: ProjectGenerationPreviewFile[] = [];
    visitTemplateTree(
      templateRoot,
      '.',
      variables,
      (relativePath, _content, substitutions) => {
        files.push({
          path: relativePath.split(sep).join('/'),
          substitutions,
        });
      },
      () => undefined,
    );

    return {
      dryRun: true,
      projectName: context.input.projectName,
      destination,
      templateId: context.template.templateId,
      files,
    };
  }

  const stagingRoot = mkdtempSync(
    join(destinationParent, `.stellarforge-${context.input.projectName}-`),
  );
  let removedExistingDestination = false;

  try {
    visitTemplateTree(
      templateRoot,
      '.',
      variables,
      (relativePath, content) => {
        const destinationPath = resolve(stagingRoot, relativePath);
        if (!isWithin(stagingRoot, destinationPath)) {
          throw new ValidationCliError(
            'Template file path escapes the trusted project root.',
          );
        }

        mkdirSync(dirname(destinationPath), { recursive: true });
        writeFileSync(destinationPath, content);
      },
      (relativePath) => {
        const destinationPath = resolve(stagingRoot, relativePath);
        if (!isWithin(stagingRoot, destinationPath)) {
          throw new ValidationCliError(
            'Template file path escapes the trusted project root.',
          );
        }

        mkdirSync(destinationPath, { recursive: false });
      },
    );

    // Re-validate immediately before the mutating write phase. The checks
    // above can be invalidated by a concurrent destination replacement while
    // copyTemplateTree was still running (it only writes into the unrelated
    // staging directory, never into `destination`), so this closes the
    // time-of-check/time-of-use gap rather than relying on the earlier check.
    assertDestinationContainment(root, destination);

    if (
      realDestinationParentAtStart !== undefined &&
      (!existsSync(destinationParent) ||
        realpathSync(destinationParent) !== realDestinationParentAtStart)
    ) {
      throw new ValidationCliError(
        'Project destination escapes its validated parent directory.',
      );
    }

    if (existsSync(destination)) {
      const destinationStat = lstatSync(destination);

      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        throw new ValidationCliError(
          'Project destination is not a safe empty directory.',
        );
      }

      if (readdirSync(destination).length > 0) {
        throw new ValidationCliError(
          'Project destination must be empty before generation.',
        );
      }

      rmdirSync(destination);
      removedExistingDestination = true;
    }

    renameSync(stagingRoot, destination);
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });

    if (removedExistingDestination && !existsSync(destination)) {
      mkdirSync(destination);
    }

    throw error;
  }

  return {
    projectName: context.input.projectName,
    destination,
    templateId: context.template.templateId,
  };
}
