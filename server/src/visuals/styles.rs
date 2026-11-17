pub const MAP_BUBBLE_CSS: &str = r#"
        /* === Premium Glassmorphism Map Tooltips === */
        .leaflet-tooltip.dc-tip, .leaflet-tooltip.edge-tip {
            background: rgba(11, 15, 25, 0.75) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            backdrop-filter: blur(16px) saturate(150%);
            color: #f8fafc;
            font-family: 'Inter', system-ui, sans-serif;
            border-radius: 12px !important;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
            transition: opacity 0.3s ease !important;
            pointer-events: none;
            transform: translateZ(0);
        }
        .leaflet-tooltip.dc-tip {
            border-color: rgba(6, 182, 212, 0.4) !important;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5), 0 0 20px rgba(6, 182, 212, 0.15) !important;
            padding: 8px 14px;
        }
        .leaflet-tooltip-top.dc-tip::before { border-top-color: rgba(6, 182, 212, 0.4); }
        .leaflet-tooltip-right.dc-tip::before { border-right-color: rgba(6, 182, 212, 0.4); }
        .leaflet-tooltip-left.dc-tip::before { border-left-color: rgba(6, 182, 212, 0.4); }

        .leaflet-tooltip.edge-tip {
            border-color: rgba(16, 185, 129, 0.4) !important;
            box-shadow: 0 8px 20px rgba(0,0,0,0.5), 0 0 15px rgba(16, 185, 129, 0.1) !important;
            font-size: 11px; padding: 5px 10px;
        }
        .leaflet-tooltip-top.edge-tip::before { border-top-color: rgba(16, 185, 129, 0.4); }
        .leaflet-tooltip-right.edge-tip::before { border-right-color: rgba(16, 185, 129, 0.4); }
        .leaflet-tooltip-left.edge-tip::before { border-left-color: rgba(16, 185, 129, 0.4); }

        .leaflet-tooltip.ip-tip {
            border-color: rgba(6, 182, 212, 0.3) !important;
            box-shadow: 0 5px 15px rgba(0,0,0,0.5) !important;
            font-family: 'SF Mono', 'Fira Code', monospace;
            font-size: 11px; padding: 4px 8px;
            color: #67e8f9;
            background: rgba(11, 15, 25, 0.7) !important;
            opacity: 0.9 !important; backdrop-filter: blur(8px);
            pointer-events: none; transform: translateZ(0);
        }
        .leaflet-tooltip-right.ip-tip::before { border-right-color: rgba(6, 182, 212, 0.3); }
        .leaflet-tooltip.ip-tip.high {
            border-color: rgba(245, 158, 11, 0.5) !important;
            box-shadow: 0 0 10px rgba(245,158,11,0.3) !important;
            color: #fcd34d; font-weight: 700;
            animation: pulse-ip 2s ease infinite alternate;
        }
        .leaflet-tooltip-right.ip-tip.high::before { border-right-color: rgba(245, 158, 11, 0.5); }
        @keyframes pulse-ip { from { opacity: 0.5; } to { opacity: 1; } }

        .neon-country { fill-opacity: 0.12 !important; transition: opacity 0.5s; transform: translateZ(0); }

        .marker-cluster { background-color: transparent !important; transform: translateZ(0); }
        .marker-cluster div {
            background: rgba(11, 15, 25, 0.8) !important;
            backdrop-filter: blur(8px);
            border-radius: 50%;
            width: 36px; height: 36px;
            display: flex; justify-content: center; align-items: center;
            font-family: 'Inter', sans-serif;
            font-weight: 700; font-size: 12px;
            transition: transform 0.2s ease, opacity 0.2s ease !important;
            transform: translateZ(0);
            box-shadow: 0 5px 15px rgba(0,0,0,0.5);
        }
        .marker-cluster:hover div { transform: scale(1.15) translateZ(0); }
        .marker-cluster-small div {
            border: 1.5px solid rgba(16, 185, 129, 0.6) !important;
            color: #34d399 !important;
            box-shadow: 0 5px 15px rgba(0,0,0,0.5), 0 0 12px rgba(16, 185, 129, 0.2) !important;
            animation: cluster-pulse-small 3s ease infinite;
        }
        @keyframes cluster-pulse-small { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }
        .marker-cluster-medium div {
            border: 1.5px solid rgba(245, 158, 11, 0.6) !important;
            color: #fbbf24 !important;
            box-shadow: 0 5px 15px rgba(0,0,0,0.5), 0 0 12px rgba(245, 158, 11, 0.2) !important;
            animation: cluster-pulse-medium 3s ease infinite;
        }
        @keyframes cluster-pulse-medium { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }
        .marker-cluster-large div {
            border: 1.5px solid rgba(239, 68, 68, 0.6) !important;
            color: #fca5a5 !important;
            box-shadow: 0 5px 15px rgba(0,0,0,0.5), 0 0 12px rgba(239, 68, 68, 0.2) !important;
            animation: cluster-pulse-large 3s ease infinite;
        }
        @keyframes cluster-pulse-large { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }

        /* Original node glow and rings, driven by the batched activity clock. */
        .leaflet-tooltip.dc-tip, .leaflet-tooltip.edge-tip {
            --activity: 0;
            --node-color: #06b6d4;
            border-color: var(--node-color) !important;
            box-shadow: 0 10px 25px rgba(0,0,0,.5),
                0 0 calc(5px + var(--activity)*25px + var(--burst,0)*20px) color-mix(in srgb,var(--node-color) 70%,transparent),
                inset 0 0 calc(3px + var(--burst,0)*5px) var(--node-color) !important;
            transition: opacity .3s ease, box-shadow .2s ease !important;
        }
        .custom-icon .node-core { transform:scale(calc(1 + var(--activity,0)*.5 + var(--burst,0)*.3)); box-shadow:0 0 calc(10px + var(--activity,0)*15px) currentColor; }
        .custom-icon .node-pulse { opacity:calc(var(--activity,0)*.85); }
        .node-pulse::after { content:''; position:absolute; top:50%; left:50%; width:8px; height:8px; margin:-4px; border:2px solid currentColor; border-radius:50%; animation:cyber-pulse 1.2s cubic-bezier(.16,1,.3,1) infinite; }
        .node-pulse.hub-pulse::after { width:14px; height:14px; margin:-7px; }
        .custom-icon:not([data-active="true"]) .node-pulse::after { animation:none; opacity:0; }
        .bubble-activity { display:block; margin-top:3px; color:var(--node-color); font:9px/1.4 ui-monospace,monospace; opacity:calc(.5 + var(--activity,0)*.5 + var(--burst,0)*.3); }
"#;