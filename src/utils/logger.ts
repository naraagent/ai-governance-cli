import chalk from 'chalk';

export function info(message: string): void {
  console.log(chalk.blue('ℹ'), message);
}

export function warn(message: string): void {
  console.log(chalk.yellow('⚠'), message);
}

export function error(message: string): void {
  console.log(chalk.red('✖'), message);
}

export function success(message: string): void {
  console.log(chalk.green('✔'), message);
}

export function heading(message: string): void {
  console.log(chalk.bold.cyan(`\n${message}\n`));
}

export function dim(message: string): void {
  console.log(chalk.dim(message));
}
