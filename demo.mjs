import readline from "node:readline";

const port = process.env.AUTODUMP_PORT ?? "4567";
const apiUrl = `http://127.0.0.1:${port}/dump`;
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const answers = [];
const pendingQuestions = [];
let inputClosed = false;

rl.on("line", (answer) => {
  const pending = pendingQuestions.shift();
  if (pending) pending.resolve(answer);
  else answers.push(answer);
});

rl.on("close", () => {
  inputClosed = true;
  for (const pending of pendingQuestions.splice(0)) {
    pending.reject(new Error("Input closed before all answers were provided."));
  }
});

function question(text) {
  process.stdout.write(text);
  if (answers.length > 0) return Promise.resolve(answers.shift());
  if (inputClosed) {
    return Promise.reject(new Error("Input closed before all answers were provided."));
  }
  return new Promise((resolve, reject) => pendingQuestions.push({ resolve, reject }));
}

async function main() {
  console.log("=== SMBIOS Autodump Demo ===");
  console.log(`API: ${apiUrl}\n`);

  const board = (await question("Motherboard model: ")).trim();
  const manufacturer = (await question("Manufacturer (MSI/ASUS/GIGABYTE): "))
    .trim()
    .toUpperCase();

  if (!board || !manufacturer) {
    throw new Error("Motherboard model and manufacturer are required.");
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ board, manufacturer }),
  });
  const responseText = await response.text();
  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`API returned a non-JSON response (HTTP ${response.status}).`);
  }

  console.log(`\nHTTP ${response.status}`);
  console.log(JSON.stringify(data, null, 2));
  if (!response.ok) {
    throw new Error(data.reason ?? "The API rejected the dump request.");
  }
  console.log("\nRequest accepted. Follow the API terminal for dump progress.");
}

main()
  .catch((error) => {
    console.error(`\nDemo failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
