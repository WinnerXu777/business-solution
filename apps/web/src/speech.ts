export function localVoice(voices: SpeechSynthesisVoice[]) {
  return (
    voices.find((voice) => voice.localService && voice.lang.toLowerCase() === 'en-ca') ??
    voices.find((voice) => voice.localService && /^en\b/i.test(voice.lang))
  );
}

export async function playSpeechLoop(
  transcript: string,
  reply: string,
  onStage: (stage: string) => void,
) {
  const speech = window.speechSynthesis;
  const voice = speech && localVoice(speech.getVoices());
  if (!voice) return false;

  function play(text: string) {
    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice!;
      utterance.onend = () => resolve();
      utterance.onerror = () => reject(new Error('Local speech playback stopped.'));
      speech.speak(utterance);
    });
  }

  speech.cancel();
  onStage('Playing the fixture transcript…');
  await play(transcript);
  onStage('Playing the synthesized reply…');
  await play(reply);
  return true;
}
