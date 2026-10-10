# The server owns the clock

A round's score is `now() - rounds.started_at`, computed on the server at the moment the last character is found. The client never reports a duration, and the timer keeps running while the tab is hidden — wall-clock time, no pausing.

The alternative was accumulating only the time the tab was visible, which needs heartbeats from the client; since those are client-supplied they can be forged, and a forged clock makes the leaderboard meaningless. Missing out because someone tabbed away was judged an acceptable cost for a score nobody can argue with. Misses carry no penalty either, so the score is exactly "how long did you take".

Consequence: the elapsed time shown in the UI is a display of the server's number, never a local stopwatch. If the client's tick and the server disagree, the server wins.