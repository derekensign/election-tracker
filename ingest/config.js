// Race registry: everything the ingest needs to know that is not derivable from a source.
// Candidate names are used to map poll columns / market outcomes onto parties.

export const US_SENATE_WIKIPEDIA_PAGE = "2026_United_States_Senate_elections";

/** Postal code -> full state name, for the 35 Senate seats up in 2026 (33 regular + OH & FL specials). */
export const SENATE_STATES = {
  AL: "Alabama", AK: "Alaska", AR: "Arkansas", CO: "Colorado", DE: "Delaware", FL: "Florida",
  GA: "Georgia", ID: "Idaho", IL: "Illinois", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MT: "Montana", NE: "Nebraska", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NC: "North Carolina", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  VA: "Virginia", WV: "West Virginia", WY: "Wyoming",
};

/** Senators NOT up in 2026, by caucus. 47 D-caucus (45 D + Sanders + King) and 53 R today. */
export const SENATE_SEATS_NOT_UP = { democraticCaucus: 34, republican: 31 };

/** Texas statewide races. `votehubType` is the VoteHub poll_type; null means VoteHub has no feed. */
export const TEXAS_STATEWIDE_RACES = [
  {
    id: "tx-senate", office: "U.S. Senate",
    democrat: "James Talarico", republican: "Ken Paxton",
    wikipedia: "2026_United_States_Senate_election_in_Texas",
    votehubType: "us-senator",
  },
  {
    id: "tx-governor", office: "Governor",
    democrat: "Gina Hinojosa", republican: "Greg Abbott",
    wikipedia: "2026_Texas_gubernatorial_election",
    votehubType: "governor",
  },
  {
    id: "tx-ltgov", office: "Lieutenant Governor",
    democrat: "Vikki Goodwin", republican: "Dan Patrick",
    wikipedia: "2026_Texas_lieutenant_gubernatorial_election",
    votehubType: null,
  },
  {
    id: "tx-ag", office: "Attorney General",
    democrat: "Nathan Johnson", republican: "Mayes Middleton",
    wikipedia: "2026_Texas_Attorney_General_election",
    votehubType: "attorney-general",
  },
  {
    id: "tx-comptroller", office: "Comptroller",
    democrat: "Sarah Eckhardt", republican: "Don Huffines",
    wikipedia: "2026_Texas_Comptroller_of_Public_Accounts_election",
    votehubType: null,
  },
  {
    id: "tx-railroad", office: "Railroad Commissioner",
    democrat: "Jon Rosenthal", republican: "Bo French",
    wikipedia: "2026_Texas_Railroad_Commissioner_election",
    votehubType: null,
  },
  {
    id: "tx-land", office: "Land Commissioner",
    democrat: "Ben Flores", republican: "Dawn Buckingham",
    wikipedia: "2026_Texas_Land_Commissioner_election",
    votehubType: null,
  },
  {
    id: "tx-agriculture", office: "Agriculture Commissioner",
    democrat: "Clayton Tucker", republican: "Nate Sheets",
    wikipedia: "2026_Texas_Commissioner_of_Agriculture_election",
    votehubType: null,
  },
];

/** Governors: the 36 states voting in 2026. */
export const GOVERNOR_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IA: "Iowa", KS: "Kansas", ME: "Maine",
  MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NM: "New Mexico", NY: "New York", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", VT: "Vermont", WI: "Wisconsin", WY: "Wyoming",
};
export const GOVERNORS_WIKIPEDIA_PAGE = "2026_United_States_gubernatorial_elections";

export const US_HOUSE = {
  wikipedia: "2026_United_States_House_of_Representatives_elections",
  ratingsPage: "2026_United_States_House_of_Representatives_election_ratings",
  texasPage: "2026_United_States_House_of_Representatives_elections_in_Texas",
  seats: 435, majority: 218,
  // Fallback if the infobox cannot be parsed: 218 R, 214 D, 3 vacancies (October 2026).
  compositionFallback: { R: 218, D: 214 },
  texasDistricts: 38,
};

/** Texas judicial and State Board of Education races (no public polling). */
export const TEXAS_COURTS = {
  supremeCourtPage: "2026_Texas_Supreme_Court_election",
  sboePage: "2026_Texas_State_Board_of_Education_election",
  electionsPage: "2026_Texas_elections",
};

export const TEXAS_LEGISLATURE = {
  house: { wikipedia: "2026_Texas_House_of_Representatives_election", seats: 150, majority: 76, current: { D: 62, R: 88 } },
  senate: { wikipedia: "2026_Texas_Senate_election", seats: 31, majority: 16, current: { D: 12, R: 19 } },
};

/** Ordinal scale for forecaster ratings: positive = Democratic advantage. */
export const RATING_SCALE = {
  "Safe D": 4, "Solid D": 4, "Likely D": 3, "Lean D": 2, "Tilt D": 1,
  "Tossup": 0, "Toss-up": 0,
  "Tilt R": -1, "Lean R": -2, "Likely R": -3, "Solid R": -4, "Safe R": -4,
};

/** Rough win probability implied by a rating, used only where no market or model number exists. */
export const RATING_PRIOR_D_WIN = { 4: 0.985, 3: 0.9, 2: 0.75, 1: 0.6, 0: 0.5, "-1": 0.4, "-2": 0.25, "-3": 0.1, "-4": 0.015 };

export const USER_AGENT = "election-tracker/0.1 (https://github.com/derekensign/election-tracker; derekensign@gmail.com)";
