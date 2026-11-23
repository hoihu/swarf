(swarf: Bushing Ø25 x 20)
(grblHAL lathe, lathe, mm)
(stock: bar Ø28, 40 out of the chuck, raw face at Z1)
(X is a diameter; Z0 = finished front face)
G21 G90 G94 G54
G18 G7 G97

(op1: Face to Z0, T1 Turning, CCMT 09 R0.4 carbide)
(Load T1: Turning, CCMT 09 R0.4 carbide, touch off, then cycle start)
(from wherever it is then, the tool goes along Z to Z23, then to X42)
M0
G21 G90 G94 G54
G18 G7 G97
G0 Z23
G0 X42
S1705 M3
G4 P2
X32 Z3
Z0
X30
G1 X0 F171
Z0.5 F60
G0 X30
X32
Z3

(op2: Turn Ø25 to Z-24, T1 Turning, CCMT 09 R0.4 carbide)
Z2
X26.7
G1 Z-24 F171
X27.7 Z-23.5
G0 Z2
X32
X25.4
G1 Z-24
X26.4 Z-23.5
G0 Z2
X32
X25
G1 Z-24
X28
X29 Z-23.5
G0 X32
Z3

(op3: Chamfer 0.8×45° at Ø25, T1 Turning, CCMT 09 R0.4 carbide)
S1910 M3
G4 P1
Z2
X22.931
G1 Z0 F67
X25 Z-1.034 F191
X27 Z-0.8
G0 X32
Z3
Z23
X42

(op4: Drill 25 deep on centre, T3 Drill Ø10 HSS)
M5
(Change to T3: Drill Ø10 HSS, touch off, then cycle start)
(from wherever it is then, the tool goes along Z to Z23, then to X42)
M0
G21 G90 G94 G54
G18 G7 G97
G0 Z23
G0 X42
S1592 M3
G4 P2
X32 Z3
X0
Z1.5
G1 Z-3.5 F239
G0 Z1.5
Z-3.2
G1 Z-8.5
G0 Z1.5
Z-8.2
G1 Z-13.5
G0 Z1.5
Z-13.2
G1 Z-18.5
G0 Z1.5
Z-18.2
G1 Z-23.5
G0 Z1.5
Z-23.2
G1 Z-25
G0 Z3
Z23
X42

(op5: Bore Ø14 to Z-23, T5 Boring bar, min. bore Ø10)
M5
(Change to T5: Boring bar, min. bore Ø10, touch off, then cycle start)
(from wherever it is then, the tool goes along Z to Z23, then to X42)
M0
G21 G90 G94 G54
G18 G7 G97
G0 Z23
G0 X42
S2500 M3
G4 P2
X32 Z3
X9
X10.925
G1 Z-22.85 F200
X10.325 Z-22.55
G0 Z3
X32
X9.925
X11.85
G1 Z-22.85
X11.25 Z-22.55
G0 Z3
X32
X10.85
X12.775
G1 Z-22.85
X12.175 Z-22.55
G0 Z3
X32
X11.775
X13.7
G1 Z-22.85
X13.1 Z-22.55
G0 Z3
X32
X12.7
X14
G1 Z-23
X9.6
X9.2 Z-22.8
G0 Z3
X32
Z23
X42

(op6: Part off at Z-20, T2 Parting blade 2 mm)
M5
(Change to T2: Parting blade 2 mm, touch off, then cycle start)
(from wherever it is then, the tool goes along Z to Z23, then to X42)
M0
G21 G90 G94 G54
G18 G7 G97
G0 Z23
G0 X42
S1273 M3
G4 P2
X32 Z3
Z-20
X26
G1 X0 F64
G0 X26
X32
Z3
Z23
X42

M5
M30
