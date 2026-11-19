import { Command } from 'commander';
import {
  resolveProjectConfig,
  type ProjectConfigOverrides,
  type ResolvedProjectConfig,
} from '../config/project.js';
import {
  defaultSpawnProcess,
  superviseDevProcesses,
  type DevOrchestratorOptions,
  type DevProcessSpawner,
} from '../dev/orchestrator.js';
import type { DevProcessSpec } from '../dev/project.js';
import {
  resolveTestnetDeploymentPlan,
  validateDeploymentOutput,
  DEPLOYMENT_TERMINATION_GRACE_MS,
  DEPLOYMENT_TIMEOUT_MS,
  type DeployedContractData,
  type DeploymentOutput,
  type TestnetDeploymentInput,
} from '../deployment/project.js';
import { ValidationCliError } from '../errors/errors.js';
import { TerminalOutput } from '../output/terminal.js';

export interface DeployCommandOptions extends DevOrchestratorOptions {
  readonly cwd?: () => string;
  readonly resolveConfig?: (
    cwd: string,
    overrides: ProjectConfigOverrides,
  ) => ResolvedProjectConfig;
  readonly resolvePlan?: (
    input: TestnetDeploymentInput,
  ) => readonly DevProcessSpec[];
  readonly validateDeployment?:
    boolean | ((output: DeploymentOutput) => DeployedContractData);
}

interface DeployCommandFlags {
  readonly network?: string;
  readonly source?: string;
}

export function createDeployCommand(
  options: DeployCommandOptions = {},
): Command {
  const {
    cwd = () => process.cwd(),
    output = new TerminalOutput(),
    resolveConfig = resolveProjectConfig,
    resolvePlan = resolveTestnetDeploymentPlan,
    validateDeployment,
  } = options;

  return new Command('deploy')
    .description('Deploy a supported StellarForge project to Stellar Testnet.')
    .option(
      '--network <network>',
      'Deployment network. CLI value overrides stellarforge.config.json.',
    )
    .option(
      '--source <identity>',
      'Named Stellar CLI identity alias. CLI value overrides project configuration.',
    )
    .action(async (flags: DeployCommandFlags) => {
      const projectRoot = cwd();

      const overrides: ProjectConfigOverrides = {
        ...(flags.network === undefined ? {} : { network: flags.network }),
        ...(flags.source === undefined ? {} : { identity: flags.source }),
      };

      const configuration = resolveConfig(projectRoot, overrides);

      const { network, identity } = configuration;

      if (network === undefined) {
        throw new ValidationCliError(
          'Deployment network is required. Pass `--network testnet` or set an explicit network in stellarforge.config.json.',
        );
      }

      if (identity === undefined) {
        throw new ValidationCliError(
          'Deployment identity is required. Pass `--source <identity>` or set a named identity in stellarforge.config.json.',
        );
      }

      const plan = resolvePlan({
        cwd: projectRoot,
        network,
        source: identity,
      });

      output.info('Deploying smart contract to Stellar Testnet.');

      let capturedStdout = '';
      let capturedStderr = '';
      let childExitCode: number | null = 0;

      let effectiveSpawnProcess: DevProcessSpawner | undefined =
        options.spawnProcess;
      if (validateDeployment) {
        const baseSpawner = options.spawnProcess ?? defaultSpawnProcess;
        effectiveSpawnProcess = (spec, env) => {
          const child = baseSpawner(spec, env);
          child.stdout.on('data', (chunk) => {
            capturedStdout += String(chunk);
          });
          child.stderr.on('data', (chunk) => {
            capturedStderr += String(chunk);
          });
          child.once('exit', (code) => {
            childExitCode = code;
          });
          return child;
        };
      }

      await superviseDevProcesses(plan, {
        ...options,
        output,
        timeoutMs: DEPLOYMENT_TIMEOUT_MS,
        terminationGraceMs: DEPLOYMENT_TERMINATION_GRACE_MS,
        timeoutMessage:
          'Deployment timed out locally after 10 minutes. The remote submission outcome is uncertain; verify the transaction manually before retrying.',
        ...(effectiveSpawnProcess === undefined
          ? {}
          : { spawnProcess: effectiveSpawnProcess }),
      });

      if (validateDeployment) {
        const validator =
          typeof validateDeployment === 'function'
            ? validateDeployment
            : validateDeploymentOutput;
        validator({
          stdout: capturedStdout,
          stderr: capturedStderr,
          exitCode: childExitCode,
        });
      }
    });
}
