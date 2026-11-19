import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadProjectConfig,
  PROJECT_CONFIG_FILENAME,
} from '../src/config/project.js';
import { ValidationCliError } from '../src/errors/index.js';
import { withTempDirectory } from './helpers/index.js';

const INVALID_JSON_MESSAGE = 'stellarforge.config.json is not valid JSON.';

const malformedJson = [
  '{',
  '{"version": 1',
  '{"version": 1,}',
  '{"version": 1 "network": "testnet"}',
  '{"version": 1,,}',
  'not json at all',
  '',
  '   ',
  '<xml/>',
  '{"version": 1}\n{',
  '[1, 2, 3',
];

const sentinelContents = [
  '{"secret": "SENTINEL-JSON"',
  '{SENTINEL-JSON',
  '[SENTINEL-JSON',
];

describe('configuration malformed-JSON handling', () => {
  it.each(malformedJson)(
    'rejects malformed JSON content %j with a stable message',
    (content) =>
      withTempDirectory((root) => {
        writeFileSync(join(root, PROJECT_CONFIG_FILENAME), content);

        expect(() => loadProjectConfig(root)).toThrow(INVALID_JSON_MESSAGE);
        expect(() => loadProjectConfig(root)).toThrow(ValidationCliError);
      }),
  );

  it('produces the same position-independent message for every malformed input', () =>
    withTempDirectory((root) => {
      const messages = malformedJson.map((content) => {
        writeFileSync(join(root, PROJECT_CONFIG_FILENAME), content);

        try {
          loadProjectConfig(root);
          return 'NO-ERROR';
        } catch (error) {
          expect(error).toBeInstanceOf(ValidationCliError);
          return (error as Error).message;
        }
      });

      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toBe(INVALID_JSON_MESSAGE);
    }));

  it('does not echo raw malformed content or parser positions', () =>
    withTempDirectory((root) => {
      for (const content of sentinelContents) {
        writeFileSync(join(root, PROJECT_CONFIG_FILENAME), content);

        try {
          loadProjectConfig(root);
          throw new Error('Expected malformed JSON to fail.');
        } catch (error) {
          expect(error).toBeInstanceOf(ValidationCliError);

          const message = (error as Error).message;
          expect(message).not.toContain('SENTINEL-JSON');
          expect(message).not.toMatch(/\bposition\b/i);
          expect(message).not.toMatch(/\bline\b/i);
          expect(message).not.toMatch(/\bcolumn\b/i);
        }
      }
    }));

  it.each(['null', '[]', '"text"', '1', 'true'])(
    'rejects valid JSON that is not an object: %j',
    (content) =>
      withTempDirectory((root) => {
        writeFileSync(join(root, PROJECT_CONFIG_FILENAME), content);

        expect(() => loadProjectConfig(root)).toThrow(
          'must contain a JSON object',
        );
      }),
  );

  it('still loads a valid configuration file', () =>
    withTempDirectory((root) => {
      writeFileSync(
        join(root, PROJECT_CONFIG_FILENAME),
        JSON.stringify({ version: 1, network: 'testnet' }),
      );

      expect(loadProjectConfig(root)).toEqual({
        version: 1,
        network: 'testnet',
      });
    }));
});

describe('configuration duplicate-key rejection (SW-216)', () => {
  it.each([
    ['version', '{"version": 1, "version": 1, "network": "testnet"}'],
    [
      'network',
      '{"version": 1, "network": "testnet", "identity": "deployer", "network": "futurenet"}',
    ],
    [
      'identity',
      '{"version": 1, "identity": "deployer", "deployer2": "x", "identity": "other"}',
    ],
  ] as const)('rejects a duplicate top-level %s key', (_key, content) =>
    withTempDirectory((root) => {
      writeFileSync(join(root, PROJECT_CONFIG_FILENAME), content);

      expect(() => loadProjectConfig(root)).toThrow(/duplicate key/);
      expect(() => loadProjectConfig(root)).toThrow(ValidationCliError);
    }));

  it('rejects duplicates even when both values are identical', () =>
    withTempDirectory((root) => {
      writeFileSync(
        join(root, PROJECT_CONFIG_FILENAME),
        '{"version": 1, "version": 1, "network": "testnet"}',
      );

      expect(() => loadProjectConfig(root)).toThrow('duplicate key "version"');
    }));

  it('rejects escape-equivalent duplicate keys', () =>
    withTempDirectory((root) => {
      writeFileSync(
        join(root, PROJECT_CONFIG_FILENAME),
        '{"version": 1, "network": "testnet", "networ\\u006b": "mainnet"}',
      );

      expect(() => loadProjectConfig(root)).toThrow('duplicate key "network"');
    }));

  it('rejects duplicate keys at deeper nesting levels', () =>
    withTempDirectory((root) => {
      const docs = [
        '{"version": 1, "extra": {"a": 1, "a": 2}}',
        '{"version": 1, "extra": [{"a": 1, "a": 2}]}',
        '{"version": 1, "a": {"b": {"c": 1}, "b": {"d": 2}}}',
      ];

      for (const content of docs) {
        writeFileSync(join(root, PROJECT_CONFIG_FILENAME), content);

        expect(() => loadProjectConfig(root)).toThrow('duplicate key');
        expect(() => loadProjectConfig(root)).toThrow(ValidationCliError);
      }
    }));

  it('identifies the duplicate key without echoing any value', () =>
    withTempDirectory((root) => {
      writeFileSync(
        join(root, PROJECT_CONFIG_FILENAME),
        '{"version": 1, "password": "SENTINEL-DUP-VALUE-xyz-123", "password": "testnet", "network": "testnet"}',
      );

      expect(() => loadProjectConfig(root)).toThrow('duplicate key "password"');
      expect(() => loadProjectConfig(root)).toThrow(ValidationCliError);

      try {
        loadProjectConfig(root);
        throw new Error('expected duplicate key error');
      } catch (error) {
        expect((error as Error).message).not.toContain('SENTINEL-DUP-VALUE');
      }
    }));

  it('stops at the first duplicate error regardless of document ordering', () =>
    withTempDirectory((root) => {
      writeFileSync(
        join(root, PROJECT_CONFIG_FILENAME),
        '{"b": 1, "a": 1, "a": 2, "b": 2}',
      );

      expect(() => loadProjectConfig(root)).toThrow('duplicate key "a"');
    }));

  it('bounds the duplicate-key message for pathological keys', () =>
    withTempDirectory((root) => {
      const key = 'k'.repeat(500);
      writeFileSync(
        join(root, PROJECT_CONFIG_FILENAME),
        `{"version": 1, "${key}": 1, "${key}": 2}`,
      );

      expect(() => loadProjectConfig(root)).toThrow('duplicate key');

      try {
        loadProjectConfig(root);
        throw new Error('expected duplicate key error');
      } catch (error) {
        expect((error as Error).message.length).toBeLessThan(200);
      }
    }));

  it('still loads a valid configuration file after the duplicate-key rule was added', () =>
    withTempDirectory((root) => {
      writeFileSync(
        join(root, PROJECT_CONFIG_FILENAME),
        JSON.stringify({ version: 1, network: 'testnet', identity: 'deployer' }),
      );

      expect(loadProjectConfig(root)).toEqual({
        version: 1,
        network: 'testnet',
        identity: 'deployer',
      });
    }));
});