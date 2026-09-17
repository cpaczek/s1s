// ---- TypeSafe API shapes (POST https://api.typesafe.ai/v1/systemone) ----

export type Structured = string | number | boolean | null | Structured[] | { [k: string]: Structured };

export type NoulQuestion = {
  type: "noul";
  instructions: Structured;
  criteria?: { true?: Structured; false?: Structured };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: Structured;
  criteria: Record<string, Structured>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: Structured;
  criteria: Structured[];
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type Usage = { input_tokens: number; output_tokens: number };

export type SystemOneResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
};
