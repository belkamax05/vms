/**
 * Put text on the system clipboard through the terminal (OSC 52), which works over SSH and needs
 * no clipboard tool installed - the same way as giti's (dev-tools' apps/giti).
 */
export const copyToClipboard = (text: string) => {
  process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString('base64')}\u0007`);
};

export default copyToClipboard;
