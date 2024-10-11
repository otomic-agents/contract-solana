/*
  Display a separator in the console, with our without a message
*/
export function printConsoleSeparator(message?: string) {
    console.log("\n===============================================");
    console.log("===============================================\n");
    if (message) console.log(message);
}

/*
Compute the Solana explorer address for the various data
*/
export function explorerURL({
    address,
    txSignature,
    cluster,
}: {
    address?: string;
    txSignature?: string;
    cluster?: "devnet" | "testnet" | "mainnet" | "mainnet-beta" | "custom";
}) {
    let baseUrl: string;
    //
    if (address) baseUrl = `https://explorer.solana.com/address/${address}`;
    else if (txSignature) baseUrl = `https://explorer.solana.com/tx/${txSignature}`;
    else return "[unknown]";

    // auto append the desired search params
    const url = new URL(baseUrl);
    url.searchParams.append("cluster", cluster || "devnet");
    return url.toString() + "\n";
}

export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
