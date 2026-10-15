/**
 * List the ElevenLabs voices available to your account.
 *
 *   node demo/engine/voices.mts
 *
 * Copy the id of the voice you want into ELEVENLABS_VOICE_ID. The API key is
 * read from ELEVENLABS_API_KEY and never printed.
 */

interface Voice {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  description?: string | null;
}

async function main(): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set.");
  const response = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey } });
  if (!response.ok) {
    throw new Error(`ElevenLabs returned ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`);
  }
  const { voices } = (await response.json()) as { voices: Voice[] };
  const selected = process.env.ELEVENLABS_VOICE_ID;
  console.log(`${voices.length} voices${selected ? ` (selected: ${selected})` : " (ELEVENLABS_VOICE_ID is not set)"}\n`);
  console.log(`${"VOICE ID".padEnd(24)} ${"NAME".padEnd(22)} ${"CATEGORY".padEnd(12)} TRAITS`);
  for (const voice of voices) {
    const traits = Object.values(voice.labels ?? {}).join(", ");
    const marker = voice.voice_id === selected ? "*" : " ";
    console.log(`${voice.voice_id.padEnd(24)}${marker}${voice.name.slice(0, 21).padEnd(22)} ${(voice.category ?? "").padEnd(12)} ${traits}`);
  }
}

main().catch((err) => {
  console.error(`list-voices failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
