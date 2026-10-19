#include <gaden/RunningSimulation.hpp>
#include <gaden/datatypes/sources/PointSource.hpp>
#include <chrono>
#include <cmath>
#include <iostream>
#include <iomanip>
#include <string>

int main(int argc,char** argv) {
  const bool absent=argc>1&&std::string(argv[1])=="absent";
  const auto begin=std::chrono::steady_clock::now();
  auto config=std::make_shared<gaden::EnvironmentConfiguration>();
  auto& e=config->environment;
  e.description.dimensions={40,20,10};e.description.cellSize=.05f;
  e.description.minCoord={0,0,0};e.description.maxCoord={2,1,.5};
  e.cells.assign(8000,gaden::Environment::CellState::Free);
  config->windSequence.Initialize(std::vector<std::vector<gaden::Vector3>>{
    std::vector<gaden::Vector3>(8000,gaden::Vector3{.05f,0,0})},8000,{});
  gaden::RunningSimulation::Parameters p;
  p.source=std::make_shared<gaden::PointSource>();
  p.source->sourcePosition={.4f,.5f,.05f};p.source->gasType=gaden::GasType::methane;
  p.deltaTime=.1f;p.numFilaments_sec=absent?0:5;p.expectedNumIterations=100;
  p.filamentInitialSigma=2;p.filamentGrowthGamma=1;p.filamentNoise_std=0;
  p.saveResults=false;p.preCalculateConcentrations=false;
  gaden::RunningSimulation simulation(p,config);
  float maximum=0;int samples=0;
  std::cout<<std::setprecision(10);
  for(int i=0;i<100;i++){
    simulation.AdvanceTimestep();
    if((i+1)%10==0)for(float height:{.05f,.1f,.2f})for(float x:{.4f,.45f,.6f}){
      const auto value=simulation.SampleConcentration(gaden::Vector3{x,.5f,height});
      if(!std::isfinite(value)||value<0)return 2;
      maximum=std::max(maximum,value);samples++;
      std::cout<<"{\"time\":"<<simulation.GetCurrentTime()<<",\"x\":"<<x<<",\"height\":"<<height<<",\"ppm\":"<<value<<"}\n";
    }
  }
  if(samples!=90||std::abs(simulation.GetCurrentTime()-10)>1e-3||(absent?maximum!=0:maximum<=0))return 3;
  const auto seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-begin).count();
  std::cout<<"{\"complete\":true,\"absent\":"<<(absent?"true":"false")<<",\"samples\":"<<samples
    <<",\"maximumPpm\":"<<maximum<<",\"wallSeconds\":"<<seconds<<",\"filaments\":"<<simulation.GetFilaments().size()<<"}\n";
  return 0;
}
