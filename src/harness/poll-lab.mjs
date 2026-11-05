import { pollEventTransition } from "../interactions/interactions.mjs";

// Host-only Twitch simulator. None of this module is included in the SE widget.
export function createPollLab({ onChange }) {
  let model = { poll: null }, revision = 0, timer = null, document, eventClock = 0n;
  const byId = id => document.getElementById(id);
  const status = message => { byId("pollStatus").textContent = message; };
  function emit(stage, event) {
    const type = "channel.poll." + stage;
    const ns = BigInt(Date.now()) * 1000000n;
    eventClock = ns > eventClock ? ns : eventClock + 1n;
    const at = new Date(Number(eventClock / 1000000n)).toISOString().replace("Z", String(eventClock % 1000000n).padStart(6, "0") + "Z");
    const payload = { type, subscription: { type }, metadata: { message_id: crypto.randomUUID(), message_timestamp: at }, event };
    const result = pollEventTransition(model, payload, "133649243");
    if (!result.accepted) { status("No enviado: " + result.reason); return false; }
    model = result.model; revision++;
    onChange(payload);
    status(stage === "end" ? "Encuesta finalizada" : "Encuesta activa, votos enviados");
    return true;
  }
  function eventFor(poll) {
    return { id: poll.id, broadcaster_user_id: "133649243", title: poll.title, started_at: poll.started_at,
      ends_at: poll.ends_at, choices: poll.choices.map(choice => ({ ...choice, bits_votes: 0, channel_points_votes: 0 })) };
  }
  function begin() {
    if (model.poll?.status === "active") { status("Ya hay una encuesta activa"); return; }
    const length = Number(byId("pollChoiceCount").value);
    const title = byId("pollTitle").value.trim();
    const names = Array.from({ length }, (_, index) => byId("pollName" + index).value.trim());
    if (!title || names.some(name => !name)) { status("Escribe la pregunta y todas las opciones"); return; }
    const now = Date.now(), duration = Math.min(1800, Math.max(15, Number(byId("pollDuration").value) || 30));
    const id = crypto.randomUUID();
    if (!emit("begin", { id, broadcaster_user_id: "133649243", title, started_at: new Date(now).toISOString(),
      ends_at: new Date(now + duration * 1000).toISOString(), choices: names.map((name, index) => ({ id: id + "-" + index, title: name })) })) return;
    for (let index = 0; index < 5; index++) byId("pollVotes" + index).value = "0";
    sendVotes();
    clearTimeout(timer);
    timer = setTimeout(() => { if (model.poll?.id === id && model.poll.status === "active") finish("completed"); }, duration * 1000);
  }
  function sendVotes() {
    const poll = model.poll;
    if (!poll || poll.status !== "active") { status("Inicia una encuesta primero"); return; }
    const event = eventFor(poll);
    event.choices.forEach((choice, index) => { choice.votes = Math.max(poll.choices[index].votes || 0, Math.max(0, Math.trunc(Number(byId("pollVotes" + index).value) || 0))); });
    if (emit("progress", event)) model.poll.choices.forEach((choice, index) => { byId("pollVotes" + index).value = String(choice.votes); });
  }
  function finish(statusValue = "terminated") {
    const poll = model.poll;
    if (!poll || poll.status !== "active") { status("No hay una encuesta activa"); return; }
    clearTimeout(timer);
    const event = eventFor(poll);
    delete event.ends_at;
    emit("end", { ...event, status: statusValue,
      ended_at: statusValue === "completed" ? poll.ends_at : new Date().toISOString() });
  }
  return {
    get poll() { return model.poll; }, get revision() { return revision; },
    mount(doc) {
      document = doc;
      byId("pollBegin").addEventListener("click", begin);
      byId("pollSendVotes").addEventListener("click", sendVotes);
      byId("pollEnd").addEventListener("click", () => finish());
      byId("pollReset").addEventListener("click", () => { clearTimeout(timer); model = { poll: null }; revision++; onChange(); status("Encuesta reiniciada"); });
      byId("pollChoiceCount").addEventListener("change", () => {
        for (let index = 0; index < 5; index++) byId("pollRow" + index).hidden = index >= Number(byId("pollChoiceCount").value);
      });
    }
  };
}
