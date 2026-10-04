import pkg from '../../package.json' with { type: 'json' };
import chalk from 'chalk';

const { name, version, description, author } = pkg as {
  name: string;
  version: string;
  description: string;
  author: {
    name: string;
    url: string;
  };
};


const ICON = `
  ██████╗ ██████╗ ██████╗  ██████╗ ██████╗  █████╗ ███╗   ███╗
  ██╔══██╗██╔══██╗╚════██╗██╔════╝ ██╔══██╗██╔══██╗████╗ ████║
  ██║  ██║██████╔╝ █████╔╝██║  ███╗██████╔╝███████║██╔████╔██║
  ██║  ██║██╔══██╗██╔═══╝ ██║   ██║██╔══██╗██╔══██║██║╚██╔╝██║
  ██████╔╝██████╔╝███████╗╚██████╔╝██║  ██║██║  ██║██║ ╚═╝ ██║
  ╚═════╝ ╚═════╝ ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝`;

const LOGO = `
${ICON}

${chalk.bold(name)} ${chalk.cyan(`v${version}`)} by ${chalk.yellow(author.name)}


${description}
                                                              `;


export default LOGO;
