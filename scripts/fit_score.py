"""Final validation: score = round_to_5(sum * LENGTH_MULTIPLIERS[tiles])."""
V = {'a':2,'b':3,'c':2,'d':2,'e':1,'f':3,'g':3,'h':3,'i':2,'j':4,'k':4,'l':1,'m':2,
     'n':1,'o':2,'p':3,'q':4,'r':1,'s':1,'t':1,'u':2,'v':4,'w':3,'x':4,'y':3,'z':4}
MULT = [0, 0, 22.5, 35, 50, 65, 75, 85, 87.5]
OBS = [("gnus",350),("hare",350),("lift",350),("wits",350),("ado",210),("auk",280),
 ("wit",210),("yew",245),("ax",135),("hosted",750),("ration",675),("trophy",975),
 ("tuxedo",900),("drubs",585),("hoofs",715),("knees",520),("manor",520),("snowy",650),
 ("votes",585),("ententes",700),("purposes",1225),("aerates",765),("eyeball",1020),
 ("sonatas",850),("tersely",765),("devote",825),("ensued",600),("moments",850),
 ("tipped",900),("cover",650),("weary",650),("woven",715),("foil",400),("out",175),
 ("rap",210),("rim",175),("toe",140),("why",315),("ye",90),
 ("doyens",750),("earthy",825),("equinox",1050),("evoked",1050),("locale",675),
 ("rawest",675),("refits",675),("soothe",750),("woodsy",975)]

def score(w):
    ww = w.replace('qu', 'q')
    s = sum(V[c] for c in ww)
    m = MULT[min(len(ww), len(MULT) - 1)]
    return int(round(s * m / 5) * 5)

bad = [(w, sc, score(w)) for w, sc in OBS if score(w) != sc]
print("mismatches:", bad if bad else f"NONE — all {len(OBS)} rows reproduced exactly")
for probe in ["equinox", "quit", "squad", "equal", "quay", "request", "quiz"]:
    print(f"  {probe:8s} -> {score(probe)}")
