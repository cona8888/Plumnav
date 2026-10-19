"""Independent event-time reconstruction: no simulator or motion-helper imports."""
import math
import numpy as np


def point(p):return np.array([p['x'],p['y']],dtype=float)


def reconstruct(record,close):
    c=record['config'];p=c['localInletSampling'];tr=np.array(record['trace']);nav=record['navigation'];controls=record['controls'];segments=record['segments']
    dt=c['fixedDt'];fine=dt/4;control=1/16;L=c['domainMeters'];clearance=math.hypot(p['robotLengthMetres'],p['robotWidthMetres'])/(2*L)
    assert record['schemaVersion']=='si-event-exact-integration-run-v1' and len(segments)==len(controls)-1
    position=point(c['robotStartPositionOverride']);heading=math.radians(c['robotStartHeadingDegrees']);distance=0.
    active=None;last_scan=None;scan_count=0;modes=[];valids=[]
    for i,row in enumerate(controls):
        time=i*control;assert row['time']==time
        close('eventControlPosition',point(row['position']),position,1e-10);close('eventControlHeading',row['heading'],heading,1e-10);close('eventControlDistance',row['distance'],distance,1e-10)
        due=round(time)==time;returned=active is not None and time>=active+12 and due
        mode='quad-passive-return' if returned else 'blanked' if active is not None else 'passive';valid=returned if active is not None else due
        assert row['measurement']['sampleMode']==mode and row['measurement']['valid']==valid
        d=row['decision'];assert not d.get('nativeTerminated') and not d.get('nativeAbstained')
        if returned:active=None
        new=False
        if i<len(controls)-1 and d.get('quadSniff') and active is None and d['quadSniff']['scanId']!=last_scan:
            last_scan=d['quadSniff']['scanId'];active=time;new=True;scan_count+=1
        if i==len(controls)-1:
            modes.append(mode);valids.append(valid)
            close('eventFinalPose',tr[-1,1:3],position,1e-10);close('eventFinalHeading',tr[-1,3],heading,1e-10)
            close('eventFinalNavPose',point(nav[-1]['position']),position,1e-10);close('eventFinalNavDistance',nav[-1]['distance'],distance,1e-10)
            assert nav[-1]['sampleMode']==mode
            break
        held=mode=='blanked' or new;turn=0.;angular=0.;speed=0.;move=0.;direction=np.zeros(2);wall=False
        desired_vector=point(d['direction']);length=np.linalg.norm(desired_vector)
        if not held and length>1e-9:
            desired=math.atan2(desired_vector[1],desired_vector[0]);delta=math.atan2(math.sin(desired-heading),math.cos(desired-heading));omega=p['maximumTurnRateRadiansPerSecond']
            angular=float(np.sign(delta))*omega;turn=min(control,abs(delta)/omega)
            speed=c['robotSpeed']*np.clip(d.get('speedScale',1),0,1)
            end_heading=heading+angular*turn;direction=np.array([math.cos(end_heading),math.sin(end_heading)])
            if turn<control and speed>0:
                until_wall=math.inf
                for axis in range(2):
                    velocity=speed*direction[axis]
                    if velocity!=0:until_wall=min(until_wall,max(0,((1-clearance if velocity>0 else clearance)-position[axis])/velocity))
                move=min(control-turn,until_wall);wall=until_wall<control-turn
        stored=segments[i]
        assert stored['version']=='event-exact-turn-move-v1' and stored['start']==time and stored['duration']==control and stored['held']==held and stored['wallLimited']==wall
        close('segmentInitialPosition',point(stored['initial']['position']),position,1e-10)
        close('segmentInitialHeading',stored['initial']['heading'],heading,1e-10);close('segmentInitialDistance',stored['initial']['distance'],distance,1e-10)
        close('segmentParameters',[stored[k] for k in ['angularVelocity','turnSeconds','moveSeconds','speed']],[angular,turn,move,speed],1e-10)
        close('segmentDirection',point(stored['direction']),direction,1e-10)
        n=round(control/fine);ages=np.arange(n)*fine;travels=speed*np.minimum(move,np.maximum(0,ages-turn))
        expected=position+travels[:,None]*direction;angles=heading+angular*np.minimum(ages,turn)
        subset=tr[i*n:(i+1)*n]
        close('eventBodyHistory',subset[:,1:3],expected,1e-10);close('eventHeadingHistory',subset[:,3],angles,1e-10)
        # Full interval zero motion, not just pose constancy at 1 Hz.
        if held:assert np.ptp(subset[:,1:4],axis=0).max()==0
        for j in range(round(control/dt)):
            k=i*round(control/dt)+j;nrow=nav[k];age=j*dt;travel=speed*min(move,max(0,age-turn))
            close('eventNavPosition',point(nrow['position']),position+direction*travel,1e-10);close('eventNavHeading',nrow['heading'],heading+angular*min(age,turn),1e-10);close('eventNavDistance',nrow['distance'],distance+travel,1e-10)
            expected_mode=mode if j==0 else 'blanked' if active is not None else 'passive'
            assert nrow['sampleMode']==expected_mode and nrow['decision']==d
            modes.append(expected_mode);valids.append(valid if j==0 else False)
        position=position+direction*speed*move;distance+=speed*move;heading+=angular*turn
    angles=tr[:,3,None]+np.array([0,-math.pi/2,math.pi,math.pi/2]);points=tr[:,None,1:3]+p['opposingInletSpacingMetres']/(2*L)*np.stack([np.cos(angles),np.sin(angles)],axis=2)
    close('inletGeometry',tr[:,4:12].reshape(-1,4,2),points,1e-12)
    assert np.min(points)>=0 and np.max(points)<=1
    return points,modes,valids,scan_count,clearance
